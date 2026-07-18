import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

function sha256Buffer(value: string) {
  return createHash('sha256').update(value).digest()
}

export function safeEqual(left: string, right: string) {
  return timingSafeEqual(sha256Buffer(left), sha256Buffer(right))
}

export function hashApiKey(value: string) {
  return createHash('sha256').update(value.trim()).digest('hex')
}

function requireAccountIdSecret(event: H3Event) {
  const config = useRuntimeConfig(event)
  const secret = String(config.accountIdSecret || '').trim()
  if (secret.length < 32) {
    throw createError({
      statusCode: 503,
      message: 'NUXT_ACCOUNT_ID_SECRET 至少需要 32 个字符'
    })
  }
  return secret
}

export function opaqueAccountId(event: H3Event, authIndex: string) {
  return createHmac('sha256', requireAccountIdSecret(event))
    .update(`codex-account:${authIndex}`)
    .digest('base64url')
    .slice(0, 24)
}
