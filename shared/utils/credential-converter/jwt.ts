type UnknownRecord = Record<string, unknown>

export function isCredentialRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function encodeBase64UrlJson(value: UnknownRecord) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

export function parseCredentialJwt(token: unknown): UnknownRecord {
  if (typeof token !== 'string' || !token.trim()) return {}
  const payload = token.split('.')[1]
  if (!payload) return {}
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    return isCredentialRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function openAiClaimSection(payload: UnknownRecord, section: 'auth' | 'profile') {
  const value = payload[`https://api.openai.com/${section}`]
  return isCredentialRecord(value) ? value : {}
}

function epochSeconds(value: unknown) {
  if (value === undefined || value === null || value === '') return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric)
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0
}

export function buildSyntheticCodexIdToken(input: {
  email: string | null
  accountId: string | null
  planType: string | null
  userId: string | null
  expiresAt: number | null
  now: Date
}) {
  if (!input.accountId) return null
  const now = Math.trunc(input.now.getTime() / 1000)
  const auth: UnknownRecord = { chatgpt_account_id: input.accountId }
  if (input.planType) auth.chatgpt_plan_type = input.planType
  if (input.userId) {
    auth.chatgpt_user_id = input.userId
    auth.user_id = input.userId
  }
  const payload: UnknownRecord = {
    iat: now,
    exp: epochSeconds(input.expiresAt) || now + 90 * 24 * 60 * 60,
    'https://api.openai.com/auth': auth
  }
  if (input.email) payload.email = input.email
  return `${encodeBase64UrlJson({ alg: 'none', typ: 'JWT', cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.synthetic`
}
