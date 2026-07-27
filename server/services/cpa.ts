import type { H3Event } from 'h3'
import type {
  CodexAccountView,
  CodexQuotaResult,
  CodexQuotaWindow,
  QuotaWindowKind
} from '#shared/types/codex'
import { opaqueAccountId } from '../utils/security'
import { normalizeBaseUrl, requireUpstreamConfig, upstreamError } from '../utils/upstream'

interface AuthFileRecord {
  name?: unknown
  type?: unknown
  provider?: unknown
  auth_index?: unknown
  authIndex?: unknown
  email?: unknown
  account?: unknown
  note?: unknown
  plan_type?: unknown
  planType?: unknown
  status?: unknown
  disabled?: unknown
  last_refresh?: unknown
  lastRefresh?: unknown
  id_token?: unknown
  [key: string]: unknown
}

interface InternalCodexAccount {
  authIndex: string
  chatgptAccountId: string | null
  view: CodexAccountView
}

interface ApiCallResponse {
  status_code?: unknown
  body?: unknown
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const FIVE_HOURS = 18_000
const WEEK = 604_800
const MIN_MONTH = 28 * 24 * 60 * 60
const MAX_MONTH = 31 * 24 * 60 * 60

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function booleanValue(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return text(value).toLowerCase() === 'true'
}

function timestampValue(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(text(value))
  return Number.isNaN(parsed) ? null : parsed
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function extractAccountId(file: AuthFileRecord) {
  const idToken = record(file.id_token)
  return text(
    file.chatgpt_account_id ||
      file.chatgptAccountId ||
      idToken?.chatgpt_account_id ||
      idToken?.chatgptAccountId
  ) || null
}

function extractPlanType(file: AuthFileRecord) {
  const idToken = record(file.id_token)
  const authClaims = record(idToken?.['https://api.openai.com/auth'])
  return (
    text(file.plan_type || file.planType || authClaims?.chatgpt_plan_type || idToken?.plan_type) ||
    null
  )
}

async function managementFetch<T>(
  event: H3Event,
  path: string,
  options: Parameters<typeof $fetch<T>>[1] = {}
) {
  const config = requireUpstreamConfig(event, ['cpaBaseUrl', 'cpaManagementKey'])
  const base = normalizeBaseUrl(config.cpaBaseUrl).replace(/\/v0\/management$/i, '')
  try {
    return await $fetch<T>(`${base}/v0/management${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.cpaManagementKey}`,
        ...(options.headers || {})
      },
      timeout: 30_000
    })
  } catch (error) {
    upstreamError(error, '无法连接 CLIProxyAPI Management API')
  }
}

export async function listCodexAccounts(event: H3Event): Promise<InternalCodexAccount[]> {
  const response = await managementFetch<{ files?: AuthFileRecord[] }>(event, '/auth-files')
  const files = Array.isArray(response.files) ? response.files : []
  return files
    .filter((file) => text(file.provider || file.type).toLowerCase().replace(/_/g, '-') === 'codex')
    .map((file) => {
      const authIndex = text(file.auth_index ?? file.authIndex)
      if (!authIndex) return null
      const view: CodexAccountView = {
        id: opaqueAccountId(event, authIndex),
        name: text(file.name) || '未命名 Codex 账号',
        email: text(file.email || file.account) || null,
        note: text(file.note) || null,
        planType: extractPlanType(file),
        status: text(file.status) || 'unknown',
        disabled: booleanValue(file.disabled),
        lastRefreshAt: timestampValue(file.last_refresh ?? file.lastRefresh)
      }
      return {
        authIndex,
        chatgptAccountId: extractAccountId(file),
        view
      }
    })
    .filter((item): item is InternalCodexAccount => Boolean(item))
}

function classifyWindow(seconds: number | null, codeReview: boolean): QuotaWindowKind {
  if (seconds === FIVE_HOURS) return codeReview ? 'code-review-five-hour' : 'five-hour'
  if (seconds === WEEK) return codeReview ? 'code-review-weekly' : 'weekly'
  if (seconds !== null && seconds >= MIN_MONTH && seconds <= MAX_MONTH) {
    return codeReview ? 'code-review-monthly' : 'monthly'
  }
  return 'other'
}

function windowLabel(kind: QuotaWindowKind, fallback: string) {
  const labels: Record<QuotaWindowKind, string> = {
    'five-hour': '5 小时额度',
    weekly: '每周额度',
    monthly: '每月额度',
    'code-review-five-hour': 'Code Review 5 小时额度',
    'code-review-weekly': 'Code Review 每周额度',
    'code-review-monthly': 'Code Review 每月额度',
    other: fallback
  }
  return labels[kind]
}

function parseResetAt(item: Record<string, unknown>) {
  const resetAt = numberValue(item.reset_at ?? item.resetAt)
  if (resetAt !== null) return resetAt < 1e12 ? resetAt * 1000 : resetAt
  const resetAfter = numberValue(item.reset_after_seconds ?? item.resetAfterSeconds)
  return resetAfter === null ? null : Date.now() + resetAfter * 1000
}

function buildWindow(
  raw: unknown,
  id: string,
  fallbackLabel: string,
  codeReview = false,
  forceUsed = false
): CodexQuotaWindow | null {
  const item = record(raw)
  if (!item) return null
  const seconds = numberValue(item.limit_window_seconds ?? item.limitWindowSeconds)
  const kind = classifyWindow(seconds, codeReview)
  const usedRaw = numberValue(item.used_percent ?? item.usedPercent)
  const usedPercent = usedRaw === null ? (forceUsed ? 100 : null) : Math.min(100, Math.max(0, usedRaw))
  return {
    id,
    label: windowLabel(kind, fallbackLabel),
    kind,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetAt: parseResetAt(item),
    windowSeconds: seconds
  }
}

function appendRateLimitWindows(
  output: CodexQuotaWindow[],
  raw: unknown,
  prefix: string,
  label: string,
  codeReview = false
) {
  const rate = record(raw)
  if (!rate) return
  const forceUsed = Boolean(rate.limit_reached ?? rate.limitReached) || rate.allowed === false
  const primary = buildWindow(
    rate.primary_window ?? rate.primaryWindow,
    `${prefix}-primary`,
    `${label}短周期额度`,
    codeReview,
    forceUsed
  )
  const secondary = buildWindow(
    rate.secondary_window ?? rate.secondaryWindow,
    `${prefix}-secondary`,
    `${label}长周期额度`,
    codeReview,
    forceUsed
  )
  if (primary) output.push(primary)
  if (secondary) output.push(secondary)
}

export function parseQuotaPayload(payload: Record<string, unknown>) {
  const windows: CodexQuotaWindow[] = []
  appendRateLimitWindows(windows, payload.rate_limit ?? payload.rateLimit, 'code', 'Codex ')
  appendRateLimitWindows(
    windows,
    payload.code_review_rate_limit ?? payload.codeReviewRateLimit,
    'review',
    'Code Review ',
    true
  )

  const additional = payload.additional_rate_limits ?? payload.additionalRateLimits
  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      const entry = record(item)
      if (!entry) return
      const name = text(entry.limit_name ?? entry.limitName ?? entry.metered_feature) || `附加额度 ${index + 1}`
      appendRateLimitWindows(
        windows,
        entry.rate_limit ?? entry.rateLimit,
        `additional-${index}`,
        `${name} `
      )
    })
  }

  return {
    planType: text(payload.plan_type ?? payload.planType) || null,
    windows
  }
}

function apiCallErrorMessage(body: unknown, statusCode: number) {
  const parsed = typeof body === 'string' ? (() => {
    try { return JSON.parse(body) } catch { return null }
  })() : body
  const bodyRecord = record(parsed)
  const errorRecord = record(bodyRecord?.error)
  return text(errorRecord?.message || bodyRecord?.error || bodyRecord?.message || body) || `上游返回 HTTP ${statusCode}`
}

export async function fetchCodexQuota(
  event: H3Event,
  account: InternalCodexAccount
): Promise<CodexQuotaResult> {
  try {
    const headers: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.76.0 (Zephyr Console)'
    }
    if (account.chatgptAccountId) headers['Chatgpt-Account-Id'] = account.chatgptAccountId

    const response = await managementFetch<ApiCallResponse>(event, '/api-call', {
      method: 'POST',
      body: {
        auth_index: account.authIndex,
        method: 'GET',
        url: CODEX_USAGE_URL,
        header: headers
      }
    })
    const statusCode = numberValue(response.status_code) || 0
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(apiCallErrorMessage(response.body, statusCode))
    }
    const payload = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
    const quotaPayload = record(payload)
    if (!quotaPayload) throw new Error('Codex 配额响应为空或格式不正确')
    const parsed = parseQuotaPayload(quotaPayload)
    return {
      ...account.view,
      planType: parsed.planType || account.view.planType,
      quotaStatus: 'success',
      windows: parsed.windows,
      refreshedAt: Date.now()
    }
  } catch (error) {
    return {
      ...account.view,
      quotaStatus: 'error',
      windows: [],
      refreshedAt: Date.now(),
      error: error instanceof Error ? error.message : '查询 Codex 配额失败'
    }
  }
}

export async function refreshAllCodexQuotas(event: H3Event, concurrency = 5) {
  const accounts = (await listCodexAccounts(event)).filter((account) => !account.view.disabled)
  const results: CodexQuotaResult[] = new Array(accounts.length)
  let cursor = 0

  async function worker() {
    while (cursor < accounts.length) {
      const index = cursor++
      results[index] = await fetchCodexQuota(event, accounts[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, () => worker()))
  return {
    accounts: accounts.map((account) => account.view),
    results
  }
}
