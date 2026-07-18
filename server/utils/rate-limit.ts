import type { H3Event } from 'h3'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const buckets = new Map<string, RateLimitEntry>()

export function enforceRateLimit(
  event: H3Event,
  scope: string,
  limit: number,
  windowMs: number
) {
  const forwarded = getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
  const address = forwarded || getRequestIP(event) || 'unknown'
  const key = `${scope}:${address}`
  const now = Date.now()
  const current = buckets.get(key)

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return
  }

  current.count += 1
  if (current.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    setResponseHeader(event, 'Retry-After', retryAfter)
    throw createError({ statusCode: 429, message: '请求过于频繁，请稍后再试' })
  }
}
