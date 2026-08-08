import { Secret, TOTP } from 'otpauth'

const TOTP_PERIOD_SECONDS = 30
const MIN_TOTP_SECRET_LENGTH = 8
const MAX_TOTP_SECRET_LENGTH = 512

export function normalizeTotpSecret(value: unknown, required = false) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    if (required) throw createError({ statusCode: 400, message: '2FA 密钥不能为空' })
    return ''
  }
  const compact = raw.replace(/[\t\n\r ]/g, '').toUpperCase()
  if (compact.length > MAX_TOTP_SECRET_LENGTH) {
    throw createError({ statusCode: 400, message: '2FA 密钥长度超出限制' })
  }
  if (!/^[A-Z2-7]+=*$/.test(compact)) {
    throw createError({ statusCode: 400, message: '2FA 密钥必须是有效的 Base32 字符' })
  }
  const firstPadding = compact.indexOf('=')
  const unpadded = firstPadding >= 0 ? compact.slice(0, firstPadding) : compact
  const padding = firstPadding >= 0 ? compact.slice(firstPadding) : ''
  if (unpadded.length < MIN_TOTP_SECRET_LENGTH) {
    throw createError({ statusCode: 400, message: `2FA 密钥不能少于 ${MIN_TOTP_SECRET_LENGTH} 个 Base32 字符` })
  }
  const expectedPadding = ({ 0: 0, 2: 6, 4: 4, 5: 3, 7: 1 } as Record<number, number | undefined>)[unpadded.length % 8]
  if (expectedPadding === undefined || padding && (padding.length !== expectedPadding || compact.length % 8 !== 0)) {
    throw createError({ statusCode: 400, message: '2FA 密钥不是规范的 Base32 编码' })
  }
  let decoded: Secret
  try { decoded = Secret.fromBase32(unpadded) } catch {
    throw createError({ statusCode: 400, message: '2FA 密钥不是有效的 Base32 编码' })
  }
  if (decoded.base32 !== unpadded) {
    throw createError({ statusCode: 400, message: '2FA 密钥包含无效的尾随位' })
  }
  return unpadded
}

export function generateTotpCode(value: unknown, timestamp = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw createError({ statusCode: 400, message: '2FA 动态码时间无效' })
  }
  const normalized = normalizeTotpSecret(value, true)
  const totp = new TOTP({
    secret: Secret.fromBase32(normalized),
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS
  })
  const generatedAt = Math.trunc(timestamp)
  return {
    code: totp.generate({ timestamp: generatedAt }),
    generatedAt,
    expiresAt: generatedAt + totp.remaining({ timestamp: generatedAt })
  }
}
