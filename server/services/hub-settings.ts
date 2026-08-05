import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { systemSettings } from '../db/schema'

let cached: { expiresAt: number; value: typeof systemSettings.$inferSelect } | null = null

export async function getHubSettings(event?: H3Event) {
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const db = useDatabase(event)
  const config = useRuntimeConfig(event)
  await db.insert(systemSettings).values({
    id: 1,
    defaultTimeoutMs: integer(config.hubRequestTimeoutMs, 1000, 600000, 120000),
    circuitFailureThreshold: integer(config.hubCircuitFailureThreshold, 1, 20, 3),
    circuitCooldownMs: integer(config.hubCircuitCooldownMs, 1000, 600000, 30000)
  }).onConflictDoNothing()
  const [value] = await db.select().from(systemSettings).where(eq(systemSettings.id, 1)).limit(1)
  if (!value) throw createError({ statusCode: 500, message: '无法读取系统设置' })
  cached = { value, expiresAt: Date.now() + 30_000 }
  return value
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function errorMessageOverrides(value: unknown, fallback: Record<string, string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const supported = new Set(['400', '401', '403', '429', '500', '502', '503', '504'])
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([status, message]) => supported.has(status) && typeof message === 'string' && message.trim())
    .map(([status, message]) => [status, String(message).trim().slice(0, 500)]))
}

export async function updateHubSettings(event: H3Event, body: Record<string, unknown>) {
  const current = await getHubSettings(event)
  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim().slice(0, 100) : current.timezone
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { throw createError({ statusCode: 400, message: '时区名称无效' }) }
  const bodyRetentionDays = integer(body.bodyRetentionDays, 1, 365, current.bodyRetentionDays)
  const metadataRetentionDays = integer(body.metadataRetentionDays, 30, 3650, current.metadataRetentionDays)
  if (metadataRetentionDays < bodyRetentionDays) {
    throw createError({ statusCode: 400, message: '详细元数据保留天数不能短于正文保留天数' })
  }
  const values = {
    timezone,
    bodyRetentionDays,
    metadataRetentionDays,
    defaultTimeoutMs: integer(body.defaultTimeoutMs, 1000, 600000, current.defaultTimeoutMs),
    circuitFailureThreshold: integer(body.circuitFailureThreshold, 1, 20, current.circuitFailureThreshold),
    circuitCooldownMs: integer(body.circuitCooldownMs, 1000, 600000, current.circuitCooldownMs),
    errorMessageOverrides: errorMessageOverrides(body.errorMessageOverrides, current.errorMessageOverrides),
    updatedAt: new Date()
  }
  const [updated] = await useDatabase(event).update(systemSettings).set(values).where(eq(systemSettings.id, 1)).returning()
  cached = null
  return updated!
}

export async function getSub2ApiDefaultProxyUpstreamId(event: H3Event) {
  return (await getHubSettings(event)).sub2apiDefaultProxyUpstreamId
}

export async function setSub2ApiDefaultProxyUpstreamId(event: H3Event, upstreamId: number | null) {
  const [updated] = await useDatabase(event).update(systemSettings).set({
    sub2apiDefaultProxyUpstreamId: upstreamId,
    updatedAt: new Date()
  }).where(eq(systemSettings.id, 1)).returning()
  if (!updated) throw createError({ statusCode: 500, message: '无法保存默认代理设置' })
  cached = null
  return updated.sub2apiDefaultProxyUpstreamId
}

export async function getCpaDefaultProxyUpstreamId(event: H3Event) {
  return (await getHubSettings(event)).cpaDefaultProxyUpstreamId
}

export async function setCpaDefaultProxyUpstreamId(event: H3Event, upstreamId: number | null) {
  const [updated] = await useDatabase(event).update(systemSettings).set({
    cpaDefaultProxyUpstreamId: upstreamId,
    updatedAt: new Date()
  }).where(eq(systemSettings.id, 1)).returning()
  if (!updated) throw createError({ statusCode: 500, message: '无法保存 CPA 默认代理设置' })
  cached = null
  return updated.cpaDefaultProxyUpstreamId
}
