import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { hubKeyCredentials, hubKeys, requestLogs } from '../db/schema'
import { deleteEncryptedBodies } from '../utils/object-storage'
import { useRedis } from '../utils/redis'
import { clearHubKeyState, CONCURRENCY_LEASE_TTL_MS, reconcileHubUsageCounters } from './hub-limits'
import { getHubSettings } from './hub-settings'
import { cleanupIdempotencyRecords } from './hub-idempotency'
import { recordUsageRollups } from './hub-rollups'

async function reconcileAbandonedRequests(event?: H3Event) {
  const db = useDatabase(event)
  const cutoff = new Date(Date.now() - CONCURRENCY_LEASE_TTL_MS)
  const candidates = await db.select({
    id: requestLogs.id,
    requestId: requestLogs.requestId,
    keyId: requestLogs.keyId,
    userId: requestLogs.userId,
    groupId: requestLogs.groupId,
    channelId: requestLogs.channelId,
    model: requestLogs.requestedModel,
    endpoint: requestLogs.endpoint,
    createdAt: requestLogs.createdAt,
    failovers: requestLogs.failoverCount
  }).from(requestLogs).where(and(
    eq(requestLogs.status, 'pending'),
    lt(requestLogs.createdAt, cutoff)
  )).limit(500)
  const redis = useRedis(event)
  let reconciled = 0
  for (const candidate of candidates) {
    if (candidate.keyId) {
      const lease = await redis.zscore(`hub:key:${candidate.keyId}:concurrency:leases`, candidate.requestId)
      if (lease && Number(lease) > Date.now()) continue
    }
    const completedAt = new Date()
    const durationMs = Math.max(0, completedAt.getTime() - candidate.createdAt.getTime())
    const [updated] = await db.update(requestLogs).set({
      status: 'stream_aborted',
      httpStatus: 499,
      errorCode: 'gateway_request_abandoned',
      errorMessage: 'Gateway request did not complete before its concurrency lease expired',
      durationMs,
      completedAt
    }).where(and(eq(requestLogs.id, candidate.id), eq(requestLogs.status, 'pending'))).returning({ id: requestLogs.id })
    if (!updated) continue
    await recordUsageRollups(event, {
      keyId: candidate.keyId,
      userId: candidate.userId,
      groupId: candidate.groupId,
      channelId: candidate.channelId,
      model: candidate.model,
      endpoint: candidate.endpoint,
      status: 'stream_aborted',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      durationMs,
      failovers: candidate.failovers
    })
    reconciled += 1
  }
  return { examined: candidates.length, reconciled }
}

export async function runHubMaintenance(event?: H3Event) {
  const db = useDatabase(event)
  const settings = await getHubSettings(event)
  const expired = await db.update(hubKeys).set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(hubKeys.status, 'active'), lt(hubKeys.expiresAt, new Date())))
    .returning({ id: hubKeys.id })
  const expiredKeys = await db.select({ id: hubKeys.id }).from(hubKeys).where(eq(hubKeys.status, 'expired'))
  const expiredCredentials = await db.update(hubKeyCredentials).set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(hubKeyCredentials.status, 'active'), lt(hubKeyCredentials.expiresAt, new Date())))
    .returning({ id: hubKeyCredentials.id })
  let keyStatesCleared = 0
  for (const key of expiredKeys) {
    if (await clearHubKeyState(event, key.id)) keyStatesCleared += 1
  }

  const expiredBodies = await db.select({ id: requestLogs.id, request: requestLogs.requestBodyObject, response: requestLogs.responseBodyObject })
    .from(requestLogs)
    .where(and(
      lt(requestLogs.bodyExpiresAt, new Date()),
      or(isNotNull(requestLogs.requestBodyObject), isNotNull(requestLogs.responseBodyObject))
    ))
    .limit(500)
  let bodyObjectsDeleted = 0
  let bodyCleanupError: string | null = null
  if (expiredBodies.length) {
    try {
      const objects = expiredBodies.flatMap(row => [row.request, row.response]).filter((key): key is string => Boolean(key))
      bodyObjectsDeleted = await deleteEncryptedBodies(event, objects)
      await db.update(requestLogs).set({ requestBodyObject: null, responseBodyObject: null }).where(inArray(requestLogs.id, expiredBodies.map(row => row.id)))
    } catch (error) {
      bodyCleanupError = error instanceof Error ? error.message.slice(0, 1000) : '正文对象清理失败'
    }
  }

  const abandonedRequests = await reconcileAbandonedRequests(event)
  const reconciliation = await reconcileHubUsageCounters(event)
  const idempotencyRecordsDeleted = await cleanupIdempotencyRecords(event)
  const metadata = await db.delete(requestLogs).where(and(
    lt(requestLogs.createdAt, new Date(Date.now() - settings.metadataRetentionDays * 86400_000)),
    isNull(requestLogs.requestBodyObject),
    isNull(requestLogs.responseBodyObject)
  )).returning({ id: requestLogs.id })

  return {
    keysExpired: expired.length,
    credentialsExpired: expiredCredentials.length,
    keyStatesCleared,
    bodyObjectsDeleted,
    bodyCleanupError,
    metadataDeleted: metadata.length,
    idempotencyRecordsDeleted,
    abandonedRequests,
    reconciliation
  }
}
