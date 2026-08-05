import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { upstreamControlOperations } from '../db/schema'
import { redactSensitiveText } from '../utils/upstream'
import { writeAudit } from './admin-auth'

type OperationStatus = 'succeeded' | 'failed' | 'reconciliation_required'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function operationFingerprint(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

export function sanitizeOperationSummary(value: Record<string, unknown>) {
  const blocked = /token|secret|password|cookie|credential|private.?key|api.?key/i
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key))
    .map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 300) : item]))
}

export function operationFailureDetails(error: unknown) {
  const item = error as { data?: { operationStage?: unknown }; message?: string }
  const errorMessage = redactSensitiveText(item.message || '上游操作失败') || '上游操作失败'
  const stage = typeof item.data?.operationStage === 'string'
    ? redactSensitiveText(item.data.operationStage).slice(0, 80)
    : ''
  return { errorMessage, operationStage: stage || null }
}

function requestId(event: H3Event) {
  const existing = getHeader(event, 'x-request-id')?.trim()
  return existing && existing.length <= 128 ? existing : `op_${randomUUID().replace(/-/g, '')}`
}

function idempotencyHash(event: H3Event, fallback: string | null) {
  const key = getHeader(event, 'idempotency-key')?.trim() || fallback
  if (!key) return null
  if (key.length > 255) throw createError({ statusCode: 400, message: 'Idempotency-Key 不能超过 255 个字符' })
  return createHash('sha256').update(key).digest('hex')
}

export function classifyUpstreamFailure(error: unknown) {
  const item = error as { statusCode?: number; response?: { status?: number; headers?: Headers }; cause?: unknown; message?: string; data?: { reconciliationRequired?: boolean } }
  const status = Number(item.response?.status || item.statusCode || 0) || null
  const request = item.response?.headers?.get?.('x-request-id') || null
  const message = String(item.message || '')
  const ambiguous = item.data?.reconciliationRequired === true || (!status && /timeout|timed out|abort|socket|network|fetch failed/i.test(message))
  return { status, request, ambiguous }
}

export async function runUpstreamOperation<T>(event: H3Event, input: {
  adminId: string
  connectionId: 'cpa' | 'sub2api'
  action: string
  targetType: string
  targetRef?: string | null
  fingerprint: unknown
  idempotencyFallback?: string | null
  safeSummary?: Record<string, unknown>
}, callback: () => Promise<{ result: T; upstreamStatus?: number; upstreamRequestId?: string | null }>) {
  const db = useDatabase(event)
  const fingerprint = operationFingerprint(input.fingerprint)
  const keyHash = idempotencyHash(event, input.idempotencyFallback || null)
  if (keyHash) {
    const [existing] = await db.select().from(upstreamControlOperations).where(and(
      eq(upstreamControlOperations.connectionId, input.connectionId),
      eq(upstreamControlOperations.action, input.action),
      eq(upstreamControlOperations.idempotencyKeyHash, keyHash)
    )).limit(1)
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw createError({ statusCode: 409, message: '相同幂等键已用于不同请求' })
      }
      throw createError({
        statusCode: 409,
        message: existing.status === 'succeeded' ? '该操作已经成功提交，请刷新列表确认' : '该操作已经提交，请先查看操作记录'
      })
    }
  }
  const safeSummary = sanitizeOperationSummary(input.safeSummary || {})
  const [operation] = await db.insert(upstreamControlOperations).values({
    requestId: requestId(event),
    adminId: input.adminId,
    connectionId: input.connectionId,
    action: input.action,
    targetType: input.targetType,
    targetRef: input.targetRef || null,
    idempotencyKeyHash: keyHash,
    requestFingerprint: fingerprint,
    safeSummary
  }).onConflictDoNothing().returning()
  if (!operation) throw createError({ statusCode: 409, message: '相同幂等操作已提交，请刷新操作记录' })
  setResponseHeader(event, 'x-request-id', operation.requestId)
  let completed: { result: T; upstreamStatus?: number; upstreamRequestId?: string | null }
  try {
    completed = await callback()
  } catch (error) {
    const failure = classifyUpstreamFailure(error)
    const status: OperationStatus = failure.ambiguous ? 'reconciliation_required' : 'failed'
    const details = operationFailureDetails(error)
    const failedSummary = { ...safeSummary, errorMessage: details.errorMessage, ...(details.operationStage ? { operationStage: details.operationStage } : {}) }
    await db.update(upstreamControlOperations).set({
      status,
      upstreamStatus: failure.status,
      upstreamRequestId: failure.request,
      safeSummary: failedSummary,
      completedAt: new Date()
    }).where(eq(upstreamControlOperations.id, operation.id))
    await writeAudit(event, input.adminId, 'upstream.operation', input.targetType, input.targetRef || null, {
      requestId: operation.requestId, connectionId: input.connectionId, action: input.action,
      status, upstreamStatus: failure.status, ...failedSummary
    })
    if (failure.ambiguous) {
      throw createError({ statusCode: 502, message: '上游结果不明确，操作已进入待对账状态，请勿重复提交' })
    }
    throw error
  }
  await db.update(upstreamControlOperations).set({
    status: 'succeeded',
    upstreamStatus: completed.upstreamStatus || 200,
    upstreamRequestId: completed.upstreamRequestId || null,
    completedAt: new Date()
  }).where(eq(upstreamControlOperations.id, operation.id))
  await writeAudit(event, input.adminId, 'upstream.operation', input.targetType, input.targetRef || null, {
    requestId: operation.requestId, connectionId: input.connectionId, action: input.action,
    status: 'succeeded', ...safeSummary
  })
  return completed.result
}

export async function listUpstreamOperations(event: H3Event, limit = 100) {
  const rows = await useDatabase(event).select().from(upstreamControlOperations)
    .orderBy(desc(upstreamControlOperations.startedAt)).limit(Math.min(200, Math.max(1, limit)))
  return rows.map(item => ({
    id: item.id,
    requestId: item.requestId,
    connectionId: item.connectionId,
    action: item.action,
    targetType: item.targetType,
    targetRef: item.targetRef,
    status: item.status,
    upstreamStatus: item.upstreamStatus,
    safeSummary: item.safeSummary,
    errorMessage: typeof item.safeSummary.errorMessage === 'string' ? item.safeSummary.errorMessage : null,
    startedAt: item.startedAt.getTime(),
    completedAt: item.completedAt?.getTime() || null
  }))
}
