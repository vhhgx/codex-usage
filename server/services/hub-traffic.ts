import type { H3Event } from 'h3'
import { useRedis } from '../utils/redis'

const DRAIN_KEY = 'hub:traffic:draining'

export interface DrainState {
  enabled: boolean
  startedAt: number | null
  expiresAt: number | null
  reason: string | null
  activeRequests: number
}

export async function activeHubRequests(event?: H3Event) {
  const redis = useRedis(event)
  let cursor = '0'
  let total = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'hub:key:*:concurrency:leases', 'COUNT', 200)
    cursor = next
    if (keys.length) {
      const transaction = redis.multi()
      for (const key of keys) {
        transaction.zremrangebyscore(key, '-inf', Date.now())
        transaction.zcard(key)
      }
      const results = await transaction.exec()
      for (let index = 1; index < (results?.length || 0); index += 2) {
        total += Math.max(0, Number(results?.[index]?.[1]) || 0)
      }
    }
  } while (cursor !== '0')
  return total
}

export async function getDrainState(event?: H3Event): Promise<DrainState> {
  const redis = useRedis(event)
  const raw = await redis.get(DRAIN_KEY)
  let value: { startedAt?: number; expiresAt?: number; reason?: string } = {}
  try { value = raw ? JSON.parse(raw) : {} } catch {}
  return {
    enabled: Boolean(raw),
    startedAt: raw ? Number(value.startedAt) || null : null,
    expiresAt: raw ? Number(value.expiresAt) || null : null,
    reason: raw && typeof value.reason === 'string' ? value.reason : null,
    activeRequests: await activeHubRequests(event)
  }
}

export async function setDrainState(event: H3Event, enabled: boolean, options: { ttlSeconds?: number; reason?: string } = {}) {
  const redis = useRedis(event)
  if (!enabled) {
    await redis.del(DRAIN_KEY)
    return getDrainState(event)
  }
  const ttlSeconds = Math.min(86400, Math.max(60, Number.isInteger(options.ttlSeconds) ? options.ttlSeconds! : 1800))
  const startedAt = Date.now()
  await redis.set(DRAIN_KEY, JSON.stringify({
    startedAt,
    expiresAt: startedAt + ttlSeconds * 1000,
    reason: String(options.reason || 'maintenance').slice(0, 200)
  }), 'EX', ttlSeconds)
  return getDrainState(event)
}

export async function assertTrafficAccepting(event: H3Event) {
  if (!await useRedis(event).exists(DRAIN_KEY)) return
  setResponseHeader(event, 'retry-after', 30)
  throw createError({
    statusCode: 503,
    data: { error: { message: 'Zephyr Hub is draining for maintenance', type: 'server_error', param: null, code: 'gateway_draining' } }
  })
}
