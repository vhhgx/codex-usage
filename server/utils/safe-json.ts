import { createHash } from 'node:crypto'

export const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 24
const MAX_FIELDS = 10_000
const MAX_STRING_LENGTH = 256 * 1024

function validateShape(value: unknown) {
  let fields = 0
  const visit = (item: unknown, depth: number) => {
    if (depth > MAX_DEPTH) throw createError({ statusCode: 400, message: `JSON 嵌套不能超过 ${MAX_DEPTH} 层` })
    if (typeof item === 'string' && item.length > MAX_STRING_LENGTH) {
      throw createError({ statusCode: 400, message: 'JSON 包含过长字符串' })
    }
    if (Array.isArray(item)) {
      fields += item.length
      if (fields > MAX_FIELDS) throw createError({ statusCode: 400, message: 'JSON 字段数量过多' })
      item.forEach(child => visit(child, depth + 1))
      return
    }
    if (item && typeof item === 'object') {
      const entries = Object.entries(item)
      fields += entries.length
      if (fields > MAX_FIELDS) throw createError({ statusCode: 400, message: 'JSON 字段数量过多' })
      entries.forEach(([key, child]) => {
        if (key.length > 512) throw createError({ statusCode: 400, message: 'JSON 字段名过长' })
        visit(child, depth + 1)
      })
    }
  }
  visit(value, 0)
}

export function parseCredentialJson(input: Buffer | string) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (!bytes.length) throw createError({ statusCode: 400, message: '认证 JSON 不能为空' })
  if (bytes.length > MAX_CREDENTIAL_BYTES) throw createError({ statusCode: 413, message: '认证 JSON 不能超过 2 MiB' })
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw createError({ statusCode: 400, message: '认证文件不是有效 JSON' })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createError({ statusCode: 400, message: '认证 JSON 顶层必须是对象' })
  }
  validateShape(value)
  return {
    value: value as Record<string, unknown>,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

export function safeCredentialPreview(value: Record<string, unknown>) {
  const text = (...keys: string[]) => keys.map(key => value[key]).find(item => typeof item === 'string' && item.trim()) as string | undefined
  return {
    type: text('type', 'provider') || 'unknown',
    account: text('email', 'account', 'name')?.slice(0, 160) || null,
    hasAccessToken: Boolean(value.access_token || value.accessToken),
    hasRefreshToken: Boolean(value.refresh_token || value.refreshToken)
  }
}

function hasAny(value: Record<string, unknown>, keys: string[]) {
  return keys.some(key => typeof value[key] === 'string' && String(value[key]).trim())
}

export function validateSubCredentialAdapter(
  platform: string,
  type: string,
  value: Record<string, unknown>,
  advanced = false
) {
  if (advanced) return
  if (type === 'oauth' || type === 'setup-token') {
    if (!hasAny(value, ['access_token', 'accessToken', 'refresh_token', 'refreshToken', 'session_token', 'sessionToken', 'setup_token'])) {
      throw createError({ statusCode: 400, message: `${platform} ${type} 凭据缺少 access_token、refresh_token 或 session_token` })
    }
    return
  }
  if (type === 'apikey') {
    if (!hasAny(value, ['api_key', 'apiKey', 'key', 'token'])) throw createError({ statusCode: 400, message: `${platform} API Key 凭据缺少 api_key` })
    return
  }
  if (type === 'service_account') {
    if (!hasAny(value, ['client_email']) || !hasAny(value, ['private_key'])) throw createError({ statusCode: 400, message: 'service_account 凭据需要 client_email 和 private_key' })
    return
  }
  if (type === 'bedrock') {
    if (!hasAny(value, ['access_key_id', 'aws_access_key_id']) || !hasAny(value, ['secret_access_key', 'aws_secret_access_key'])) {
      throw createError({ statusCode: 400, message: 'Bedrock 凭据需要 access_key_id 和 secret_access_key' })
    }
    return
  }
  if (type === 'upstream' && !hasAny(value, ['api_key', 'apiKey', 'token'])) {
    throw createError({ statusCode: 400, message: 'upstream 凭据缺少 api_key 或 token' })
  }
}
