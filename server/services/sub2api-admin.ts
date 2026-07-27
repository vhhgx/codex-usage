import type { H3Event } from 'h3'
import type {
  Sub2ApiAccountQuotaResult,
  Sub2ApiAccountQuotaWindow,
  Sub2ApiAccountView
} from '#shared/types/sub2api-admin'
import { opaqueSub2ApiAccountId } from '../utils/security'
import { normalizeBaseUrl, requireUpstreamConfig } from '../utils/upstream'

type UnknownRecord = Record<string, unknown>

interface InternalAccount {
  upstreamId: number
  raw: UnknownRecord
  view: Sub2ApiAccountView
}

interface PaginatedAccounts {
  items: unknown[]
  total: number
  page: number
  pages: number
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

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

function booleanValue(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  return fallback
}

function timestampValue(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(text(value))
  return Number.isNaN(parsed) ? null : parsed
}

function errorMessage(error: unknown, fallback: string) {
  const data = record((error as { data?: unknown })?.data)
  const nested = record(data?.data)
  return text(data?.message ?? nested?.message) ||
    (error instanceof Error ? error.message : '') ||
    fallback
}

function unwrap<T>(payload: unknown): T {
  const envelope = record(payload)
  if (!envelope) throw new Error('Sub2API 管理接口响应格式不正确')
  const code = numberValue(envelope.code)
  if (code !== null && code !== 0) {
    throw new Error(text(envelope.message) || `Sub2API 管理接口返回错误 ${code}`)
  }
  return (Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : envelope) as T
}

async function adminFetch<T>(
  event: H3Event,
  path: string,
  options: Parameters<typeof $fetch>[1] = {}
): Promise<T> {
  const config = requireUpstreamConfig(event, ['sub2apiBaseUrl', 'sub2apiAdminApiKey'])
  const base = normalizeBaseUrl(config.sub2apiBaseUrl)
    .replace(/\/api\/v1$/i, '')
    .replace(/\/v1$/i, '')
  try {
    const payload = await $fetch<unknown>(`${base}/api/v1/admin${path}`, {
      ...options,
      headers: {
        'x-api-key': String(config.sub2apiAdminApiKey),
        ...(options.headers || {})
      },
      timeout: 30_000
    })
    return unwrap<T>(payload)
  } catch (error) {
    const status = Number((error as { response?: { status?: number }; statusCode?: number })?.response?.status ||
      (error as { statusCode?: number })?.statusCode || 0)
    throw createError({
      statusCode: status === 401 || status === 403 ? 502 : status >= 400 && status < 500 ? status : 502,
      message: status === 401 || status === 403
        ? 'Sub2API 管理密钥无效或权限不足'
        : errorMessage(error, '无法连接 Sub2API 管理接口')
    })
  }
}

function accountView(event: H3Event, raw: UnknownRecord): InternalAccount | null {
  const upstreamId = numberValue(raw.id)
  if (upstreamId === null || upstreamId < 1) return null
  return {
    upstreamId,
    raw,
    view: {
      id: opaqueSub2ApiAccountId(event, upstreamId),
      name: text(raw.name) || `账号 ${upstreamId}`,
      notes: text(raw.notes) || null,
      platform: text(raw.platform) || 'unknown',
      accountType: text(raw.type) || 'unknown',
      status: text(raw.status) || 'unknown',
      schedulable: booleanValue(raw.schedulable, true),
      errorMessage: text(raw.error_message) || null,
      expiresAt: timestampValue(raw.expires_at),
      concurrency: Math.max(0, numberValue(raw.concurrency) || 0),
      currentConcurrency: Math.max(0, numberValue(raw.current_concurrency) || 0)
    }
  }
}

async function listAccountPage(event: H3Event, page: number) {
  const data = await adminFetch<PaginatedAccounts>(event, '/accounts', {
    query: { page, page_size: 1000, sort_by: 'name', sort_order: 'asc' }
  })
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: Math.max(0, numberValue(data.total) || 0),
    page: Math.max(1, numberValue(data.page) || page),
    pages: Math.max(1, numberValue(data.pages) || 1)
  }
}

export async function listSub2ApiAccounts(event: H3Event): Promise<InternalAccount[]> {
  const first = await listAccountPage(event, 1)
  const rows = [...first.items]
  for (let page = 2; page <= first.pages; page++) {
    rows.push(...(await listAccountPage(event, page)).items)
  }
  return rows
    .map(record)
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((item) => accountView(event, item))
    .filter((item): item is InternalAccount => Boolean(item))
}

function percentWindow(
  id: string,
  label: string,
  utilization: unknown,
  resetAt: unknown = null,
  used: number | null = null,
  limit: number | null = null
): Sub2ApiAccountQuotaWindow | null {
  const parsed = numberValue(utilization)
  if (parsed === null && (limit === null || limit <= 0)) return null
  const usedPercent = parsed === null
    ? Math.min(100, Math.max(0, (used || 0) / (limit || 1) * 100))
    : Math.min(100, Math.max(0, parsed))
  return {
    id,
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    used,
    limit,
    resetAt: timestampValue(resetAt)
  }
}

function absoluteWindow(
  id: string,
  label: string,
  usedValue: unknown,
  limitValue: unknown,
  resetAt: unknown = null
) {
  const used = Math.max(0, numberValue(usedValue) || 0)
  const limit = numberValue(limitValue)
  return percentWindow(id, label, null, resetAt, used, limit)
}

export function parseSub2ApiAccountWindows(
  account: UnknownRecord,
  usageValue: unknown
): { planType: string | null; windows: Sub2ApiAccountQuotaWindow[]; usageError: string } {
  const usage = record(usageValue) || {}
  const extra = record(account.extra) || {}
  const credentials = record(account.credentials) || {}
  const liveIdentity = record(credentials.live_identity) || {}
  const windows: Sub2ApiAccountQuotaWindow[] = []
  const seen = new Set<string>()
  const add = (window: Sub2ApiAccountQuotaWindow | null) => {
    if (window && !seen.has(window.id)) {
      seen.add(window.id)
      windows.push(window)
    }
  }

  add(absoluteWindow('account-total', '账号总额度', account.quota_used, account.quota_limit))
  add(absoluteWindow('account-daily', '每日额度', account.quota_daily_used, account.quota_daily_limit, account.quota_daily_reset_at))
  add(absoluteWindow('account-weekly', '每周额度', account.quota_weekly_used, account.quota_weekly_limit, account.quota_weekly_reset_at))

  const progressWindows = [
    ['five_hour', '5 小时额度'],
    ['seven_day', '7 天额度'],
    ['seven_day_sonnet', 'Sonnet 7 天额度'],
    ['seven_day_fable', 'Fable 7 天额度'],
    ['gemini_shared_daily', 'Gemini 每日共享额度'],
    ['gemini_pro_daily', 'Gemini Pro 每日额度'],
    ['gemini_flash_daily', 'Gemini Flash 每日额度'],
    ['gemini_shared_minute', 'Gemini 每分钟共享额度'],
    ['gemini_pro_minute', 'Gemini Pro 每分钟额度'],
    ['gemini_flash_minute', 'Gemini Flash 每分钟额度']
  ] as const
  progressWindows.forEach(([key, label]) => {
    const progress = record(usage[key])
    if (progress) add(percentWindow(key, label, progress.utilization, progress.resets_at))
  })

  if (!seen.has('five_hour')) {
    add(percentWindow('codex-5h', 'Codex 5 小时额度', extra.codex_5h_used_percent, extra.codex_5h_reset_at ||
      (numberValue(extra.codex_5h_reset_after_seconds) !== null
        ? Date.now() + (numberValue(extra.codex_5h_reset_after_seconds) || 0) * 1000
        : null)))
  }
  if (!seen.has('seven_day')) {
    add(percentWindow('codex-7d', 'Codex 7 天额度', extra.codex_7d_used_percent, extra.codex_7d_reset_at ||
      (numberValue(extra.codex_7d_reset_after_seconds) !== null
        ? Date.now() + (numberValue(extra.codex_7d_reset_after_seconds) || 0) * 1000
        : null)))
  }

  const antigravity = record(usage.antigravity_quota)
  if (antigravity) {
    Object.entries(antigravity).forEach(([model, value]) => {
      const quota = record(value)
      if (quota) add(percentWindow(`antigravity-${model}`, model, quota.utilization, quota.reset_time))
    })
  }

  ;([
    ['grok_request_quota', 'Grok 请求额度'],
    ['grok_token_quota', 'Grok Token 额度']
  ] as const).forEach(([key, label]) => {
    const quota = record(usage[key])
    if (!quota) return
    const limit = numberValue(quota.limit)
    const remaining = numberValue(quota.remaining)
    const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null
    add(percentWindow(key, label, null, quota.reset_at ?? quota.reset_unix, used, limit))
  })

  return {
    planType: text(
      usage.subscription_tier ||
      usage.subscription_tier_raw ||
      credentials.plan_type ||
      credentials.chatgpt_plan_type ||
      liveIdentity.official_plan ||
      liveIdentity.plan ||
      account.plan_type ||
      account.subscription_tier ||
      extra.plan_type ||
      extra.plan ||
      extra.subscription_tier
    ) || null,
    windows,
    usageError: text(usage.error)
  }
}

export async function fetchSub2ApiAccountQuota(
  event: H3Event,
  account: InternalAccount,
  active = false
): Promise<Sub2ApiAccountQuotaResult> {
  try {
    const usage = await adminFetch<UnknownRecord>(
      event,
      `/accounts/${account.upstreamId}/usage`,
      active ? { query: { source: 'active', force: 'true' } } : {}
    )
    const parsed = parseSub2ApiAccountWindows(account.raw, usage)
    return {
      ...account.view,
      quotaStatus: parsed.usageError && !parsed.windows.length ? 'error' : 'success',
      planType: parsed.planType,
      windows: parsed.windows,
      refreshedAt: timestampValue(usage.updated_at) || Date.now(),
      usageSource: active ? 'active' : 'passive',
      ...(parsed.usageError ? { error: parsed.usageError } : {})
    }
  } catch (error) {
    const parsed = parseSub2ApiAccountWindows(account.raw, null)
    return {
      ...account.view,
      quotaStatus: parsed.windows.length ? 'success' : 'error',
      planType: parsed.planType,
      windows: parsed.windows,
      refreshedAt: Date.now(),
      usageSource: active ? 'active' : 'passive',
      error: errorMessage(error, '查询账号额度失败')
    }
  }
}

export async function getAllSub2ApiAccountQuotas(
  event: H3Event,
  active = false,
  concurrency = active ? 5 : 10
) {
  const accounts = await listSub2ApiAccounts(event)
  const results: Sub2ApiAccountQuotaResult[] = new Array(accounts.length)
  let cursor = 0
  async function worker() {
    while (cursor < accounts.length) {
      const index = cursor++
      results[index] = await fetchSub2ApiAccountQuota(event, accounts[index]!, active)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, () => worker()))
  return results
}

export async function findSub2ApiAccount(event: H3Event, publicId: string) {
  const accounts = await listSub2ApiAccounts(event)
  return accounts.find((account) => account.view.id === publicId) || null
}
