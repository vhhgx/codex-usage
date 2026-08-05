import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'

function decodeCanonicalBase64Url(value: string, expectedLength?: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('加密数据包含无效的 Base64URL')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value || expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error('加密数据不是规范的 Base64URL')
  }
  return decoded
}

export function secretEncryptionKey(event?: H3Event) {
  const encoded = String(useRuntimeConfig(event).encryptionKey || '').trim()
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) {
    throw createError({ statusCode: 503, message: 'NUXT_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥' })
  }
  return key
}

export function encryptSecret(value: string, event?: H3Event) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretEncryptionKey(event), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptSecret(value: string, event?: H3Event) {
  const [version, ivRaw, tagRaw, bodyRaw] = value.split('.')
  if (version !== 'v1' || !ivRaw || !tagRaw || !bodyRaw) throw new Error('不支持的加密数据格式')
  const decipher = createDecipheriv('aes-256-gcm', secretEncryptionKey(event), decodeCanonicalBase64Url(ivRaw, 12))
  decipher.setAuthTag(decodeCanonicalBase64Url(tagRaw, 16))
  return Buffer.concat([decipher.update(decodeCanonicalBase64Url(bodyRaw)), decipher.final()]).toString('utf8')
}

function secretContextAad(context: string) {
  const normalized = context.trim()
  if (!normalized || normalized.length > 500) throw new Error('加密上下文无效')
  return Buffer.from(`zephyr-context-secret:${normalized}:v2`, 'utf8')
}

export function encryptContextSecret(value: string, context: string, event?: H3Event) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretEncryptionKey(event), iv)
  cipher.setAAD(secretContextAad(context))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptContextSecret(value: string, context: string, event?: H3Event) {
  const [version, ivRaw, tagRaw, bodyRaw] = value.split('.')
  if (version !== 'v2' || !ivRaw || !tagRaw || !bodyRaw) throw new Error('不支持的上下文加密数据格式')
  const decipher = createDecipheriv('aes-256-gcm', secretEncryptionKey(event), decodeCanonicalBase64Url(ivRaw, 12))
  decipher.setAAD(secretContextAad(context))
  decipher.setAuthTag(decodeCanonicalBase64Url(tagRaw, 16))
  return Buffer.concat([decipher.update(decodeCanonicalBase64Url(bodyRaw)), decipher.final()]).toString('utf8')
}

function hubPepper(event?: H3Event) {
  const pepper = String(useRuntimeConfig(event).hubKeyPepper || '').trim()
  if (pepper.length < 32) throw createError({ statusCode: 503, message: 'NUXT_HUB_KEY_PEPPER 至少需要 32 个字符' })
  return pepper
}

export function hashHubKey(value: string, event?: H3Event) {
  return createHmac('sha256', hubPepper(event)).update(value.trim()).digest('hex')
}

export function hashIdempotencyKey(keyId: string, value: string, event?: H3Event) {
  return createHmac('sha256', hubPepper(event)).update(`idempotency:${keyId}:${value}`).digest('hex')
}

export function createHubKey() {
  return `zh-${randomBytes(32).toString('base64url')}`
}

export function validateHubKeySecret(value: string) {
  if (value.length < 16 || value.length > 512 || !/^[!-~]+$/.test(value)) {
    throw createError({ statusCode: 400, message: 'Key 必须是 16 到 512 位的可打印非空白 ASCII 字符' })
  }
  return value
}

export function parseHubKeyEncryptionKeys(raw: string | Record<string, unknown>) {
  let parsed: unknown
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { throw createError({ statusCode: 503, message: 'NUXT_HUB_KEY_ENCRYPTION_KEYS 必须是 JSON 密钥环' }) }
  } else {
    parsed = raw
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw createError({ statusCode: 503, message: 'Hub Key 加密密钥环格式不正确' })
  const keys = new Map<string, Buffer>()
  for (const [version, encoded] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(version) || typeof encoded !== 'string') continue
    const key = Buffer.from(encoded, 'base64')
    if (key.length === 32) keys.set(version, key)
  }
  if (!keys.size) throw createError({ statusCode: 503, message: 'Hub Key 加密密钥环没有有效的 32 字节密钥' })
  return keys
}

function hubKeyAad(context: string, version: string) {
  return Buffer.from(`zephyr-hub-key:${context}:${version}`, 'utf8')
}

export function encryptHubKeyValue(value: string, context: string, activeVersion: string, keys: Map<string, Buffer>) {
  validateHubKeySecret(value)
  const key = keys.get(activeVersion)
  if (!key) throw createError({ statusCode: 503, message: `Hub Key 加密密钥版本 ${activeVersion} 不存在` })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(hubKeyAad(context, activeVersion))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    encrypted: `hkv1.${activeVersion}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`,
    version: activeVersion
  }
}

export function decryptHubKeyValue(value: string, context: string, keys: Map<string, Buffer>) {
  const [format, version, ivRaw, tagRaw, bodyRaw] = value.split('.')
  if (format !== 'hkv1' || !version || !ivRaw || !tagRaw || !bodyRaw) throw new Error('不支持的 Hub Key 密文格式')
  const key = keys.get(version)
  if (!key) throw new Error(`Hub Key 加密密钥版本 ${version} 不存在`)
  const decipher = createDecipheriv('aes-256-gcm', key, decodeCanonicalBase64Url(ivRaw, 12))
  decipher.setAAD(hubKeyAad(context, version))
  decipher.setAuthTag(decodeCanonicalBase64Url(tagRaw, 16))
  return Buffer.concat([decipher.update(decodeCanonicalBase64Url(bodyRaw)), decipher.final()]).toString('utf8')
}

function hubKeyKeyring(event?: H3Event) {
  const config = useRuntimeConfig(event)
  const activeVersion = String(config.hubKeyEncryptionActiveVersion || 'v1').trim()
  const raw = config.hubKeyEncryptionKeys
  const keys = parseHubKeyEncryptionKeys(raw && typeof raw === 'object' ? raw as Record<string, unknown> : String(raw || ''))
  return { activeVersion, keys }
}

export function encryptHubKeySecret(value: string, keyId: string, credentialId: string, event?: H3Event) {
  const { activeVersion, keys } = hubKeyKeyring(event)
  return encryptHubKeyValue(value, `${keyId}:${credentialId}`, activeVersion, keys)
}

export function decryptHubKeySecret(value: string, keyId: string, credentialId: string, event?: H3Event) {
  return decryptHubKeyValue(value, `${keyId}:${credentialId}`, hubKeyKeyring(event).keys)
}

export function hashClientIp(value: string, event?: H3Event) {
  return createHmac('sha256', hubPepper(event)).update(`ip:${value}`).digest('hex').slice(0, 24)
}

export function contentHash(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
}
