import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { trustedClientIp } from './client-ip'
import { useRedis } from './redis'

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`

export function rateLimitKey(scope: string, address: string) {
  const digest = createHash('sha256').update(`${scope}:${address}`).digest('hex')
  return `hub:rate-limit:${scope}:${digest}`
}

export async function enforceRateLimit(
  event: H3Event,
  scope: string,
  limit: number,
  windowMs: number
) {
  const key = rateLimitKey(scope, trustedClientIp(event))
  const result = await useRedis(event).eval(RATE_LIMIT_SCRIPT, 1, key, windowMs) as [number | string, number | string]
  const count = Number(result[0])
  if (count <= limit) return
  const retryAfter = Math.max(1, Math.ceil(Math.max(0, Number(result[1])) / 1000))
  setResponseHeader(event, 'Retry-After', retryAfter)
  throw createError({ statusCode: 429, message: '请求过于频繁，请稍后再试' })
}
