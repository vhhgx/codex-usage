import { and, eq, lt, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { idempotencyRecords } from '../db/schema'
import { contentHash, hashIdempotencyKey } from '../utils/hub-crypto'
import { readEncryptedBody } from '../utils/object-storage'

const LOCK_MS = 10 * 60_000

interface IdempotencyAcquisition {
  record: typeof idempotencyRecords.$inferSelect
  replay: { body: Buffer; contentType: string; status: number } | null
}

function idempotencyError(statusCode: number, message: string, code: string): never {
  throw createError({ statusCode, data: { error: { message, type: 'invalid_request_error', param: null, code } } })
}

export async function acquireIdempotency(event: H3Event, keyId: string, endpoint: string, requestBody: Buffer, streaming: boolean): Promise<IdempotencyAcquisition | null> {
  const rawKey = (getHeader(event, 'idempotency-key') || '').trim()
  if (!rawKey) return null
  if (rawKey.length > 255) idempotencyError(400, 'Idempotency-Key is too long', 'invalid_idempotency_key')
  if (streaming) idempotencyError(400, 'Idempotency-Key is not supported for streaming requests', 'idempotency_streaming_unsupported')
  const db = useDatabase(event)
  const now = new Date()
  const requestHash = contentHash(requestBody)
  const idempotencyKeyHash = hashIdempotencyKey(keyId, rawKey, event)
  const [created] = await db.insert(idempotencyRecords).values({
    keyId,
    endpoint,
    idempotencyKeyHash,
    requestHash,
    lockedUntil: new Date(now.getTime() + LOCK_MS)
  }).onConflictDoNothing().returning()
  if (created) return { record: created, replay: null }

  const [existing] = await db.select().from(idempotencyRecords).where(and(
    eq(idempotencyRecords.keyId, keyId),
    eq(idempotencyRecords.endpoint, endpoint),
    eq(idempotencyRecords.idempotencyKeyHash, idempotencyKeyHash)
  )).limit(1)
  if (!existing) idempotencyError(409, 'Idempotency state changed; retry the request', 'idempotency_conflict')
  if (existing.requestHash !== requestHash) idempotencyError(409, 'Idempotency-Key was already used with a different request', 'idempotency_key_reused')
  if (existing.status === 'completed' && existing.responseBodyObject && existing.responseStatus !== null) {
    const response = await readEncryptedBody(event, existing.responseBodyObject)
    return { record: existing, replay: { body: response.body, contentType: existing.responseContentType || response.contentType, status: existing.responseStatus } }
  }
  if (existing.status === 'completed_unavailable' || existing.status === 'indeterminate') {
    idempotencyError(409, 'The original request may have completed but its response cannot be replayed', 'idempotency_result_unavailable')
  }
  if (existing.status === 'processing' && existing.lockedUntil > now) {
    setResponseHeader(event, 'retry-after', Math.max(1, Math.ceil((existing.lockedUntil.getTime() - now.getTime()) / 1000)))
    idempotencyError(409, 'A request with this Idempotency-Key is still processing', 'idempotency_in_progress')
  }
  const [locked] = await db.update(idempotencyRecords).set({ status: 'processing', lockedUntil: new Date(now.getTime() + LOCK_MS), updatedAt: now })
    .where(and(eq(idempotencyRecords.id, existing.id), or(eq(idempotencyRecords.status, 'failed'), lt(idempotencyRecords.lockedUntil, now))))
    .returning()
  if (!locked) idempotencyError(409, 'A request with this Idempotency-Key is still processing', 'idempotency_in_progress')
  return { record: locked, replay: null }
}

export async function completeIdempotency(
  event: H3Event,
  id: string,
  responseStatus: number,
  responseContentType: string,
  responseBodyObject: string | null
) {
  await useDatabase(event).update(idempotencyRecords).set({
    status: responseBodyObject ? 'completed' : 'completed_unavailable',
    responseStatus,
    responseContentType,
    responseBodyObject,
    completedAt: new Date(),
    updatedAt: new Date()
  }).where(eq(idempotencyRecords.id, id))
}

export async function failIdempotency(event: H3Event, id: string, upstreamStarted: boolean) {
  await useDatabase(event).update(idempotencyRecords).set({
    status: upstreamStarted ? 'indeterminate' : 'failed',
    lockedUntil: new Date(),
    updatedAt: new Date()
  }).where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.status, 'processing')))
}

export async function cleanupIdempotencyRecords(event?: H3Event) {
  const deleted = await useDatabase(event).delete(idempotencyRecords)
    .where(lt(idempotencyRecords.updatedAt, new Date(Date.now() - 7 * 86400_000)))
    .returning({ id: idempotencyRecords.id })
  return deleted.length
}
