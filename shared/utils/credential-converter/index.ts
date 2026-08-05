/*
 * Adapted from GPTSession2CPAandSub2API at commit a097eb1.
 * Copyright (c) 2026 Dehujiaogeli, used under the MIT License.
 */
import {
  buildSyntheticCodexIdToken,
  isCredentialRecord,
  openAiClaimSection,
  parseCredentialJwt
} from './jwt'
import type {
  ConvertedCredentialAccount,
  CredentialConversionResult,
  CredentialSourceDocument,
  SkippedCredentialSource
} from './types'

export type * from './types'

type UnknownRecord = Record<string, unknown>
type Candidate = { value: UnknownRecord; sourceName: string; sourcePath: string }

export const MAX_CONVERSION_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 24
const MAX_FIELDS = 10_000
const MAX_STRING_LENGTH = 256 * 1024
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function record(value: unknown) {
  return isCredentialRecord(value) ? value : undefined
}

function nested(value: UnknownRecord, key: string) {
  return record(value[key])
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function stripUnavailable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnavailable).filter(item => item !== undefined)
  if (isCredentialRecord(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripUnavailable(item)] as const)
      .filter(([, item]) => item !== undefined)
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return value === undefined || value === null || value === '' ? undefined : value
}

function normalizeTimestamp(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e11 ? value : value * 1000)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function unixSeconds(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null
}

function validateDocument(value: unknown) {
  let fields = 0
  const visit = (item: unknown, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`JSON 嵌套不能超过 ${MAX_DEPTH} 层`)
    if (typeof item === 'string' && item.length > MAX_STRING_LENGTH) throw new Error('JSON 包含过长字符串')
    if (Array.isArray(item)) {
      fields += item.length
      if (fields > MAX_FIELDS) throw new Error('JSON 字段数量过多')
      item.forEach(child => visit(child, depth + 1))
      return
    }
    if (!isCredentialRecord(item)) return
    const entries = Object.entries(item)
    fields += entries.length
    if (fields > MAX_FIELDS) throw new Error('JSON 字段数量过多')
    entries.forEach(([key, child]) => {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`JSON 包含不安全字段：${key}`)
      if (key.length > 512) throw new Error('JSON 字段名过长')
      visit(child, depth + 1)
    })
  }
  visit(value, 0)
}

function accessToken(value: UnknownRecord) {
  const tokens = nested(value, 'tokens')
  const token = nested(value, 'token')
  const credentials = nested(value, 'credentials')
  return firstText(
    value.accessToken, value.access_token,
    tokens?.accessToken, tokens?.access_token,
    token?.accessToken, token?.access_token,
    credentials?.accessToken, credentials?.access_token
  )
}

function hasExplicitIdentity(value: UnknownRecord) {
  const tokens = nested(value, 'tokens')
  const meta = nested(value, 'meta')
  const providerData = nested(value, 'providerSpecificData')
  return Boolean(record(value.user)) || Boolean(firstText(
    value.email, value.name, value.label, meta?.label, value.id,
    tokens?.accountId, tokens?.account_id, tokens?.chatgptAccountId, tokens?.chatgpt_account_id,
    providerData?.chatgptAccountId, providerData?.chatgpt_account_id
  ))
}

function collectCandidates(document: CredentialSourceDocument) {
  const found: Candidate[] = []
  const visited = new WeakSet<object>()
  const visit = (item: unknown, path: string) => {
    if (!isCredentialRecord(item) && !Array.isArray(item)) return
    if (typeof item === 'object' && item !== null) {
      if (visited.has(item)) return
      visited.add(item)
    }
    if (isCredentialRecord(item)) {
      const token = accessToken(item)
      const claims = parseCredentialJwt(token)
      const auth = openAiClaimSection(claims, 'auth')
      if (token && (hasExplicitIdentity(item) || firstText(claims.email, auth.chatgpt_account_id))) {
        found.push({ value: item, sourceName: document.name, sourcePath: path })
        return
      }
      for (const [key, child] of Object.entries(item)) {
        if (['accessToken', 'access_token', 'sessionToken', 'session_token'].includes(key)) continue
        visit(child, `${path}.${key}`)
      }
      return
    }
    item.forEach((child, index) => visit(child, `${path}[${index}]`))
  }
  visit(document.value, '$')
  return found
}

function sourceType(value: UnknownRecord) {
  if (value.provider === 'codex' && value.authType === 'oauth') return '9router'
  if (value.auth_mode === 'chatgpt') return 'codex_auth'
  if (record(value.meta) && record(value.tokens)) return 'codex_manager'
  if (record(value.credentials)) return 'sub2api'
  if (value.type === 'codex') return 'cpa'
  return 'chatgpt_web_session'
}

function emailKey(email: string | null) {
  return email?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || undefined
}

function convertCandidate(candidate: Candidate, index: number, now: Date): ConvertedCredentialAccount {
  const value = candidate.value
  const tokens = nested(value, 'tokens')
  const token = nested(value, 'token')
  const credentials = nested(value, 'credentials')
  const user = nested(value, 'user')
  const account = nested(value, 'account')
  const meta = nested(value, 'meta')
  const providerData = nested(value, 'providerSpecificData')
  const extra = nested(value, 'extra')
  const access = accessToken(value)
  if (!access) throw new Error('缺少 access token')
  const refresh = firstText(
    value.refreshToken, value.refresh_token,
    tokens?.refreshToken, tokens?.refresh_token,
    token?.refreshToken, token?.refresh_token,
    credentials?.refreshToken, credentials?.refresh_token
  )
  const session = firstText(
    value.sessionToken, value.session_token,
    tokens?.sessionToken, tokens?.session_token,
    token?.sessionToken, token?.session_token,
    credentials?.sessionToken, credentials?.session_token
  )
  const inputIdToken = firstText(
    value.idToken, value.id_token,
    tokens?.idToken, tokens?.id_token,
    token?.idToken, token?.id_token,
    credentials?.idToken, credentials?.id_token
  )
  const accessClaims = parseCredentialJwt(access)
  const idClaims = parseCredentialJwt(inputIdToken)
  const auth = openAiClaimSection(accessClaims, 'auth')
  const idAuth = openAiClaimSection(idClaims, 'auth')
  const profile = openAiClaimSection(accessClaims, 'profile')
  const email = firstText(
    user?.email, value.email, extra?.email, meta?.email, meta?.label, value.label,
    credentials?.email, providerData?.email, profile.email, idClaims.email, accessClaims.email
  )
  const accountId = firstText(
    account?.id, value.accountId, value.account_id,
    tokens?.accountId, tokens?.account_id,
    value.chatgptAccountId, value.chatgpt_account_id,
    meta?.chatgptAccountId, meta?.chatgpt_account_id,
    tokens?.chatgptAccountId, tokens?.chatgpt_account_id,
    providerData?.chatgptAccountId, providerData?.chatgpt_account_id,
    credentials?.chatgpt_account_id, auth.chatgpt_account_id, idAuth.chatgpt_account_id,
    value.provider === 'codex' ? value.id : undefined
  )
  const userId = firstText(
    user?.id, value.userId, value.user_id, value.chatgptUserId, value.chatgpt_user_id,
    providerData?.chatgptUserId, providerData?.chatgpt_user_id,
    credentials?.chatgpt_user_id, auth.chatgpt_user_id, auth.user_id, idAuth.chatgpt_user_id, idAuth.user_id
  )
  const planType = firstText(
    account?.planType, account?.plan_type, value.planType, value.plan_type,
    providerData?.chatgptPlanType, providerData?.chatgpt_plan_type,
    credentials?.plan_type, auth.chatgpt_plan_type, idAuth.chatgpt_plan_type
  )
  const hasRefreshToken = Boolean(refresh)
  const accessTokenExpiresAt = hasRefreshToken ? null : unixSeconds(accessClaims.exp)
  const expiresIso = hasRefreshToken ? null : firstText(
    accessTokenExpiresAt ? new Date(accessTokenExpiresAt * 1000).toISOString() : null,
    normalizeTimestamp(value.expires), normalizeTimestamp(value.expiresAt),
    normalizeTimestamp(value.expired), normalizeTimestamp(value.expires_at),
    normalizeTimestamp(credentials?.expires_at)
  )
  const expiresAt = expiresIso ? Date.parse(expiresIso) : null
  const synthetic = inputIdToken ? null : buildSyntheticCodexIdToken({ email, accountId, planType, userId, expiresAt, now })
  const idToken = inputIdToken || synthetic
  const name = firstText(value.name, meta?.label, email, candidate.sourceName, `转换账号 ${index + 1}`)!
  const exportedAt = now.toISOString()
  const warnings: string[] = []
  if (!refresh) warnings.push('仅短期 access token')
  if (!inputIdToken && synthetic) warnings.push('使用合成 id token')
  if (!idToken) warnings.push('缺少 id token，不能导入 CPA')
  if (!email) warnings.push('未识别邮箱')
  if (!accountId) warnings.push('未识别账号 ID')
  if (expiresAt && expiresAt <= now.getTime()) warnings.push('凭据已过期')

  const cpaCredential = Object.fromEntries(Object.entries({
    type: 'codex',
    account_id: accountId,
    chatgpt_account_id: accountId,
    email,
    name,
    plan_type: planType,
    chatgpt_plan_type: planType,
    id_token: idToken,
    id_token_synthetic: synthetic ? true : undefined,
    access_token: access,
    refresh_token: refresh || '',
    session_token: session,
    last_refresh: exportedAt,
    expired: expiresIso,
    disabled: value.disabled === true ? true : undefined
  }).filter(([, item]) => item !== undefined && item !== null))
  const sub2apiCredentials = stripUnavailable({
    access_token: access,
    refresh_token: refresh,
    session_token: session,
    id_token: idToken,
    id_token_synthetic: synthetic ? true : undefined,
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    email,
    plan_type: planType
  }) as UnknownRecord
  const sub2apiExtra = stripUnavailable({
    email,
    email_key: emailKey(email),
    name,
    auth_provider: firstText(value.authProvider, value.auth_provider, 'openai'),
    source: sourceType(value),
    source_name: candidate.sourceName,
    last_refresh: exportedAt
  }) as UnknownRecord
  return {
    key: `${candidate.sourceName}:${candidate.sourcePath}:${index}`,
    sourceName: candidate.sourceName,
    sourcePath: candidate.sourcePath,
    sourceType: sourceType(value),
    name,
    email,
    accountId,
    userId,
    planType,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    accessTokenExpiresAt,
    hasRefreshToken,
    hasIdToken: Boolean(inputIdToken),
    syntheticIdToken: Boolean(synthetic),
    cpaReady: Boolean(idToken),
    warnings,
    cpaCredential,
    sub2apiCredentials,
    sub2apiExtra
  }
}

export function parseCredentialSourceText(text: string, sourceName = 'pasted-json'): CredentialSourceDocument {
  if (!text.trim()) throw new Error('请输入凭据 JSON')
  if (new TextEncoder().encode(text).byteLength > MAX_CONVERSION_BYTES) throw new Error('单个凭据 JSON 不能超过 2 MiB')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : '格式不正确'}`)
  }
  validateDocument(value)
  return { name: sourceName, value }
}

export function convertCredentialDocuments(documents: CredentialSourceDocument[], now = new Date()): CredentialConversionResult {
  if (!documents.length) throw new Error('请选择或粘贴凭据 JSON')
  const candidates = documents.flatMap((document) => {
    validateDocument(document.value)
    return collectCandidates(document)
  })
  const accounts: ConvertedCredentialAccount[] = []
  const skipped: SkippedCredentialSource[] = []
  const seenTokens = new Set<string>()
  candidates.forEach((candidate, index) => {
    const token = accessToken(candidate.value)
    if (token && seenTokens.has(token)) {
      skipped.push({ sourceName: candidate.sourceName, sourcePath: candidate.sourcePath, message: '重复凭据已跳过' })
      return
    }
    try {
      const converted = convertCandidate(candidate, index, now)
      if (token) seenTokens.add(token)
      accounts.push(converted)
    } catch (error) {
      skipped.push({
        sourceName: candidate.sourceName,
        sourcePath: candidate.sourcePath,
        message: error instanceof Error ? error.message : '转换失败'
      })
    }
  })
  if (!accounts.length && !skipped.length) {
    skipped.push({ sourceName: documents[0]?.name || '凭据', sourcePath: '$', message: '没有识别到包含账号信息的 access token' })
  }
  return { accounts, skipped }
}

export function convertCredentialSourceText(text: string, sourceName = 'pasted-json', now = new Date()) {
  return convertCredentialDocuments([parseCredentialSourceText(text, sourceName)], now)
}

export function cpaCredentialFileName(account: Pick<ConvertedCredentialAccount, 'email' | 'accountId' | 'name'>) {
  const source = account.email || account.accountId || account.name || 'chatgpt-session'
  const token = source
    .replace(/\.[^.]+$/u, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'chatgpt-session'
  return `codex-${token}.json`
}
