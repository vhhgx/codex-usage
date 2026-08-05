import type { H3Event } from 'h3'
import type {
  Sub2ApiAccountQuotaResult,
  Sub2ApiAccountQuotaWindow,
  Sub2ApiAccountView
} from '#shared/types/sub2api-admin'
import type { SubAccountManagementView, SubGroupView, SubProxyProtocol, SubProxyView } from '#shared/types/upstream-management'
import { opaqueSub2ApiAccountId, opaqueSub2ApiGroupId, opaqueSub2ApiProxyId } from '../utils/security'
import { normalizeBaseUrl, redactSensitiveText, requireUpstreamConfig } from '../utils/upstream'
import { getCpaDefaultProxyUpstreamId, getSub2ApiDefaultProxyUpstreamId, setSub2ApiDefaultProxyUpstreamId } from './hub-settings'

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

interface InternalProxy {
  upstreamId: number
  raw: UnknownRecord
  view: SubProxyView
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

const TERMINAL_ACCOUNT_CODES = new Set([
  'account_deactivated',
  'account_disabled',
  'deactivated_workspace',
  'invalid_grant',
  'invalid_token',
  'token_expired',
  'unauthorized',
  'workspace_deactivated',
  'workspace_not_found'
])

export function parseSub2ApiActiveUsageFailure(value: unknown) {
  const usage = record(value)
  if (!usage) return { message: 'Sub2API 主动验活响应格式不正确', code: null, terminal: false }
  const error = record(usage.error)
  const detail = record(usage.detail) || record(error?.detail)
  const rawMessage = text(usage.error) || text(usage.error_message) || text(error?.message) || text(detail?.message) || text(usage.message)
  const embeddedCode = rawMessage.match(/"code"\s*:\s*"([a-z][a-z0-9_-]{2,80})"/i)?.[1]
  const knownCode = [...TERMINAL_ACCOUNT_CODES].find(candidate => rawMessage.toLowerCase().includes(candidate))
  const inferredCode = /workspace (?:has been )?deactivated|workspace deactivated|\b402\b/i.test(rawMessage) ? 'deactivated_workspace' : ''
  const code = (text(detail?.code) || text(error?.code) || text(usage.error_code) || embeddedCode || knownCode || inferredCode || '').toLowerCase() || null
  const failed = Boolean(
    usage.error || code ||
    usage.success === false || usage.ok === false ||
    ['error', 'failed', 'invalid'].includes(text(usage.status).toLowerCase())
  )
  if (!failed) return null
  const message = redactSensitiveText(rawMessage || (code ? `上游账号不可用：${code}` : '上游账号主动验活失败')).slice(0, 500)
  const terminal = Boolean(code && TERMINAL_ACCOUNT_CODES.has(code)) ||
    /\b(?:deactivated_workspace|workspace_deactivated|account_deactivated|invalid_grant|invalid_token|token_expired)\b|workspace (?:has been )?deactivated/i.test(message)
  return { message, code, terminal }
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

function accountImportStepError(error: unknown, stage: string, accountCreated: boolean) {
  const item = error as { statusCode?: number; data?: Record<string, unknown>; message?: string }
  const message = redactSensitiveText(item.message || 'Sub2API 管理接口调用失败') || 'Sub2API 管理接口调用失败'
  return createError({
    statusCode: Number(item.statusCode) || 502,
    message: `${stage}失败：${message}`,
    data: {
      ...(item.data && typeof item.data === 'object' ? item.data : {}),
      operationStage: stage,
      ...(accountCreated ? { reconciliationRequired: true } : {})
    }
  })
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

export async function sub2ApiAdminFetch<T>(
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
    const rawMessage = errorMessage(error, '无法连接 Sub2API 管理接口')
    const ambiguous = !status && /timeout|timed out|abort|socket|network|fetch failed/i.test(rawMessage)
    throw createError({
      statusCode: status === 401 || status === 403 ? 502 : status >= 400 && status < 500 ? status : 502,
      message: status === 401 || status === 403
        ? 'Sub2API 管理密钥无效或权限不足'
        : redactSensitiveText(rawMessage),
      data: ambiguous ? { reconciliationRequired: true } : undefined
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
  const data = await sub2ApiAdminFetch<PaginatedAccounts>(event, '/accounts', {
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
    usageError: parseSub2ApiActiveUsageFailure(usage)?.message || ''
  }
}

export async function fetchSub2ApiAccountQuota(
  event: H3Event,
  account: InternalAccount,
  active = false
): Promise<Sub2ApiAccountQuotaResult> {
  try {
    const usage = await sub2ApiAdminFetch<UnknownRecord>(
      event,
      `/accounts/${account.upstreamId}/usage`,
      active ? { query: { source: 'active', force: 'true' } } : {}
    )
    const parsed = parseSub2ApiAccountWindows(account.raw, usage)
    return {
      ...account.view,
      quotaStatus: parsed.usageError ? 'error' : 'success',
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

const GROUP_POLICY_FIELDS = [
  'is_exclusive', 'allow_image_generation', 'allow_batch_image_generation',
  'image_rate_independent', 'image_rate_multiplier', 'batch_image_discount_multiplier',
  'batch_image_hold_multiplier', 'video_rate_independent', 'video_rate_multiplier',
  'peak_rate_enabled', 'peak_start', 'peak_end', 'peak_rate_multiplier',
  'image_price_1k', 'image_price_2k', 'image_price_4k', 'video_price_480p',
  'video_price_720p', 'video_price_1080p', 'web_search_price_per_call',
  'claude_code_only', 'model_routing_enabled', 'mcp_xml_inject', 'supported_model_scopes',
  'allow_messages_dispatch', 'allow_live', 'require_oauth_only', 'require_privacy_set',
  'default_mapped_model', 'messages_dispatch_model_config', 'models_list_config',
  'max_reasoning_effort', 'reasoning_effort_mappings'
] as const

interface InternalGroup { upstreamId: number; raw: UnknownRecord; view: SubGroupView }

function groupPolicy(raw: UnknownRecord) {
  return Object.fromEntries(GROUP_POLICY_FIELDS
    .filter(key => Object.prototype.hasOwnProperty.call(raw, key))
    .map(key => [key, raw[key]]))
}

async function rawGroups(event: H3Event) {
  const rows: unknown[] = []
  let page = 1
  let pages = 1
  do {
    const data = await sub2ApiAdminFetch<{ items?: unknown[]; pages?: number }>(event, '/groups', {
      query: { page, page_size: 1000, sort_by: 'name', sort_order: 'asc' }
    })
    rows.push(...(Array.isArray(data.items) ? data.items : []))
    pages = Math.max(1, numberValue(data.pages) || 1)
    page++
  } while (page <= pages)
  return rows.map(record).filter((item): item is UnknownRecord => Boolean(item))
}

export async function listManagedSub2ApiGroups(event: H3Event): Promise<InternalGroup[]> {
  const rows = await rawGroups(event)
  const names = new Map(rows.map(item => [numberValue(item.id), text(item.name)]))
  const counts = new Map<number, number>()
  const hasCounts = rows.every(item => numberValue(item.account_count) !== null)
  if (hasCounts) rows.forEach(item => counts.set(numberValue(item.id) || 0, numberValue(item.account_count) || 0))
  else {
    const accounts = await listSub2ApiAccounts(event)
    accounts.forEach(account => {
      const ids = Array.isArray(account.raw.group_ids) ? account.raw.group_ids : []
      ids.forEach(value => {
        const id = numberValue(value)
        if (id !== null) counts.set(id, (counts.get(id) || 0) + 1)
      })
    })
  }
  return rows.map(raw => {
    const upstreamId = numberValue(raw.id)
    if (upstreamId === null || upstreamId < 1) return null
    const fallback = numberValue(raw.fallback_group_id)
    const invalidFallback = numberValue(raw.fallback_group_id_on_invalid_request)
    return {
      upstreamId,
      raw,
      view: {
        id: opaqueSub2ApiGroupId(event, upstreamId),
        name: text(raw.name) || `分组 ${upstreamId}`,
        description: text(raw.description) || null,
        platform: text(raw.platform) || 'unknown',
        status: text(raw.status) || 'unknown',
        subscriptionType: text(raw.subscription_type) || null,
        rateMultiplier: numberValue(raw.rate_multiplier) ?? 1,
        dailyLimit: numberValue(raw.daily_limit_usd),
        weeklyLimit: numberValue(raw.weekly_limit_usd),
        monthlyLimit: numberValue(raw.monthly_limit_usd),
        rpmLimit: numberValue(raw.rpm_limit),
        allowImage: booleanValue(raw.allow_image_generation),
        allowVideo: booleanValue(raw.video_rate_independent) || numberValue(raw.video_rate_multiplier) !== null,
        fallbackGroupId: fallback ? opaqueSub2ApiGroupId(event, fallback) : null,
        fallbackGroupName: fallback ? names.get(fallback) || null : null,
        invalidFallbackGroupId: invalidFallback ? opaqueSub2ApiGroupId(event, invalidFallback) : null,
        invalidFallbackGroupName: invalidFallback ? names.get(invalidFallback) || null : null,
        accountCount: counts.get(upstreamId) || 0,
        policy: groupPolicy(raw),
        updatedAt: timestampValue(raw.updated_at)
      }
    }
  }).filter((item): item is InternalGroup => Boolean(item))
}

export async function resolveManagedSub2ApiGroup(event: H3Event, opaqueId: string) {
  const group = (await listManagedSub2ApiGroups(event)).find(item => item.view.id === opaqueId)
  if (!group) throw createError({ statusCode: 404, message: 'Sub2API 分组不存在或已变化' })
  return group
}

export async function resolveSub2ApiGroupIds(event: H3Event, ids: unknown) {
  if (!Array.isArray(ids)) throw createError({ statusCode: 400, message: 'groupIds 必须是数组' })
  const groups = await listManagedSub2ApiGroups(event)
  return ids.map(value => {
    const match = groups.find(group => group.view.id === String(value))
    if (!match) throw createError({ statusCode: 400, message: '包含不存在的分组' })
    return match.upstreamId
  })
}

function proxyStatus(raw: UnknownRecord) {
  const status = text(raw.status).toLowerCase()
  if (status) return status
  return booleanValue(raw.enabled, true) ? 'active' : 'inactive'
}

function proxyAvailable(proxy: InternalProxy) {
  return proxy.view.status === 'active' && (!proxy.view.expiresAt || proxy.view.expiresAt > Date.now())
}

async function rawProxies(event: H3Event) {
  const first = await sub2ApiAdminFetch<unknown>(event, '/proxies', {
    query: { page: 1, page_size: 1000, sort_by: 'name', sort_order: 'asc' }
  })
  if (Array.isArray(first)) return first.map(record).filter((item): item is UnknownRecord => Boolean(item))
  const envelope = record(first) || {}
  const rows = Array.isArray(envelope.items) ? [...envelope.items] : []
  const pages = Math.max(1, numberValue(envelope.pages) || 1)
  for (let page = 2; page <= pages; page++) {
    const data = await sub2ApiAdminFetch<unknown>(event, '/proxies', {
      query: { page, page_size: 1000, sort_by: 'name', sort_order: 'asc' }
    })
    const pageEnvelope = record(data) || {}
    rows.push(...(Array.isArray(pageEnvelope.items) ? pageEnvelope.items : Array.isArray(data) ? data : []))
  }
  return rows.map(record).filter((item): item is UnknownRecord => Boolean(item))
}

export async function listManagedSub2ApiProxies(event: H3Event, withAccountCounts = true): Promise<InternalProxy[]> {
  const rows = await rawProxies(event)
  const names = new Map(rows.map(item => [numberValue(item.id), text(item.name)]))
  const computedCounts = new Map<number, number>()
  if (withAccountCounts && rows.some(item => numberValue(item.account_count) === null)) {
    ;(await listSub2ApiAccounts(event)).forEach(account => {
      const proxyId = numberValue(account.raw.proxy_id)
      if (proxyId) computedCounts.set(proxyId, (computedCounts.get(proxyId) || 0) + 1)
    })
  }
  return rows.map(raw => {
    const upstreamId = numberValue(raw.id)
    if (!upstreamId || upstreamId < 1) return null
    const protocol = text(raw.protocol).toLowerCase()
    if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) return null
    const backupId = numberValue(raw.backup_proxy_id)
    return {
      upstreamId,
      raw,
      view: {
        id: opaqueSub2ApiProxyId(event, upstreamId),
        name: text(raw.name) || `代理 ${upstreamId}`,
        protocol: protocol as SubProxyProtocol,
        host: text(raw.host),
        port: Math.max(0, numberValue(raw.port) || 0),
        username: text(raw.username) || null,
        hasPassword: Boolean(text(raw.password)),
        status: proxyStatus(raw),
        expiresAt: timestampValue(raw.expires_at),
        fallbackMode: text(raw.fallback_mode) || 'direct',
        backupProxyId: backupId ? opaqueSub2ApiProxyId(event, backupId) : null,
        backupProxyName: backupId ? names.get(backupId) || null : null,
        expiryWarnDays: Math.max(0, numberValue(raw.expiry_warn_days) ?? 7),
        accountCount: Math.max(0, numberValue(raw.account_count) ?? computedCounts.get(upstreamId) ?? 0),
        latencyMs: numberValue(raw.latency_ms ?? raw.last_latency_ms ?? raw.test_latency_ms),
        qualityScore: numberValue(raw.quality_score ?? raw.quality),
        lastCheckedAt: timestampValue(raw.last_checked_at ?? raw.last_test_at ?? raw.quality_checked_at),
        errorMessage: text(raw.error_message ?? raw.last_error) || null
      }
    }
  }).filter((item): item is InternalProxy => Boolean(item))
}

export async function resolveManagedSub2ApiProxy(event: H3Event, opaqueId: string) {
  const proxy = (await listManagedSub2ApiProxies(event, false)).find(item => item.view.id === opaqueId)
  if (!proxy) throw createError({ statusCode: 404, message: 'Sub2API 代理不存在或已变化' })
  return proxy
}

async function validDefaultProxy(event: H3Event) {
  const upstreamId = await getSub2ApiDefaultProxyUpstreamId(event)
  if (!upstreamId) return null
  const proxy = (await listManagedSub2ApiProxies(event, false)).find(item => item.upstreamId === upstreamId)
  if (proxy && proxyAvailable(proxy)) return proxy
  await setSub2ApiDefaultProxyUpstreamId(event, null)
  return null
}

export async function resolveSub2ApiProxySelection(
  event: H3Event,
  value: unknown,
  useDefaultWhenMissing = false,
  allowDirect = true
) {
  if (value === null || value === '' || value === undefined) {
    if (useDefaultWhenMissing) return (await validDefaultProxy(event))?.upstreamId ?? null
    if (allowDirect) return null
    throw createError({ statusCode: 400, message: '必须选择代理' })
  }
  const proxy = await resolveManagedSub2ApiProxy(event, String(value))
  if (!proxyAvailable(proxy)) throw createError({ statusCode: 409, message: '所选代理已停用或过期' })
  return proxy.upstreamId
}

export async function getManagedSub2ApiProxyState(event: H3Event) {
  const proxies = await listManagedSub2ApiProxies(event)
  const defaultUpstreamId = await getSub2ApiDefaultProxyUpstreamId(event)
  const selected = defaultUpstreamId ? proxies.find(item => item.upstreamId === defaultUpstreamId) : null
  if (defaultUpstreamId && (!selected || !proxyAvailable(selected))) {
    await setSub2ApiDefaultProxyUpstreamId(event, null)
  }
  return {
    proxies: proxies.map(item => item.view),
    defaultProxyId: selected && proxyAvailable(selected) ? selected.view.id : null
  }
}

export async function setManagedSub2ApiDefaultProxy(event: H3Event, opaqueId: string | null) {
  if (!opaqueId) {
    await setSub2ApiDefaultProxyUpstreamId(event, null)
    return { defaultProxyId: null }
  }
  const proxy = await resolveManagedSub2ApiProxy(event, opaqueId)
  if (!proxyAvailable(proxy)) throw createError({ statusCode: 409, message: '停用或过期的代理不能设为默认代理' })
  await setSub2ApiDefaultProxyUpstreamId(event, proxy.upstreamId)
  return { defaultProxyId: proxy.view.id }
}

function completeProxyUpdate(target: InternalProxy, payload: UnknownRecord) {
  const raw = target.raw
  return {
    name: text(raw.name),
    protocol: text(raw.protocol),
    host: text(raw.host),
    port: numberValue(raw.port),
    username: text(raw.username),
    expires_at: raw.expires_at ?? null,
    fallback_mode: text(raw.fallback_mode) || 'direct',
    backup_proxy_id: numberValue(raw.backup_proxy_id),
    expiry_warn_days: Math.max(0, numberValue(raw.expiry_warn_days) ?? 7),
    status: proxyStatus(raw),
    ...payload
  }
}

export async function createManagedSub2ApiProxy(event: H3Event, payload: UnknownRecord) {
  const created = await sub2ApiAdminFetch<UnknownRecord>(event, '/proxies', { method: 'POST', body: payload })
  const id = numberValue(created.id)
  if (!id) throw createError({ statusCode: 502, message: 'Sub2API 创建代理后未返回代理 ID' })
  const proxy = (await listManagedSub2ApiProxies(event)).find(item => item.upstreamId === id)
  if (!proxy) throw createError({ statusCode: 502, message: 'Sub2API 代理创建后对账失败' })
  return proxy.view
}

export async function updateManagedSub2ApiProxy(event: H3Event, opaqueId: string, payload: UnknownRecord) {
  const target = await resolveManagedSub2ApiProxy(event, opaqueId)
  if (numberValue(payload.backup_proxy_id) === target.upstreamId) {
    throw createError({ statusCode: 400, message: '备用代理不能指向自身' })
  }
  await sub2ApiAdminFetch(event, `/proxies/${target.upstreamId}`, {
    method: 'PUT',
    body: completeProxyUpdate(target, payload)
  })
  const refreshed = (await listManagedSub2ApiProxies(event)).find(item => item.upstreamId === target.upstreamId)
  if (!refreshed) throw createError({ statusCode: 502, message: 'Sub2API 代理更新后对账失败' })
  if (!proxyAvailable(refreshed) && await getSub2ApiDefaultProxyUpstreamId(event) === target.upstreamId) {
    await setSub2ApiDefaultProxyUpstreamId(event, null)
  }
  return refreshed.view
}

function proxyCheckResult(value: unknown) {
  const result = record(value) || {}
  const failed = result.ok === false || result.success === false || ['error', 'failed'].includes(text(result.status).toLowerCase())
  return {
    ok: !failed,
    message: redactSensitiveText(text(result.message ?? result.error) || (failed ? '代理检测失败' : '代理检测通过')).slice(0, 300),
    latencyMs: numberValue(result.latency_ms ?? result.latency),
    qualityScore: numberValue(result.quality_score ?? result.quality)
  }
}

export async function testManagedSub2ApiProxy(event: H3Event, opaqueId: string, quality = false) {
  const target = await resolveManagedSub2ApiProxy(event, opaqueId)
  const result = await sub2ApiAdminFetch<unknown>(event, `/proxies/${target.upstreamId}/${quality ? 'quality-check' : 'test'}`, { method: 'POST' })
  return proxyCheckResult(result)
}

export async function deleteManagedSub2ApiProxy(event: H3Event, opaqueId: string) {
  const target = await resolveManagedSub2ApiProxy(event, opaqueId)
  const accounts = await listSub2ApiAccounts(event)
  const accountCount = accounts.filter(item => numberValue(item.raw.proxy_id) === target.upstreamId).length
  const fallbackCount = (await listManagedSub2ApiProxies(event, false)).filter(item => numberValue(item.raw.backup_proxy_id) === target.upstreamId).length
  const isDefault = await getSub2ApiDefaultProxyUpstreamId(event) === target.upstreamId
  const isCpaDefault = await getCpaDefaultProxyUpstreamId(event) === target.upstreamId
  if (accountCount || fallbackCount || isDefault || isCpaDefault) {
    throw createError({
      statusCode: 409,
      message: `代理仍被 ${accountCount} 个账号、${fallbackCount} 个备用策略${isDefault ? '、Sub2API 默认代理' : ''}${isCpaDefault ? '、CPA 默认代理' : ''}引用，不能删除`
    })
  }
  await sub2ApiAdminFetch(event, `/proxies/${target.upstreamId}`, { method: 'DELETE' })
  if ((await listManagedSub2ApiProxies(event, false)).some(item => item.upstreamId === target.upstreamId)) {
    throw createError({ statusCode: 502, message: 'Sub2API 返回删除成功，但代理仍然存在' })
  }
  return { deleted: true, name: target.view.name }
}

function accountGroups(raw: UnknownRecord) {
  const source = Array.isArray(raw.groups) ? raw.groups : Array.isArray(raw.account_groups) ? raw.account_groups : []
  const groups = source.map(record).filter(Boolean) as UnknownRecord[]
  return groups.map(group => text(group.name)).filter(Boolean)
}

function accountProxyEditable(raw: UnknownRecord) {
  return !booleanValue(raw.is_shadow) && numberValue(raw.parent_account_id) === null &&
    numberValue(raw.shadow_parent_id) === null && text(raw.account_role).toLowerCase() !== 'shadow'
}

export function managedAccountView(event: H3Event, account: InternalAccount, proxies: InternalProxy[] = []): SubAccountManagementView {
  const ids = Array.isArray(account.raw.group_ids) ? account.raw.group_ids : []
  const proxyId = numberValue(account.raw.proxy_id)
  const fallbackOriginId = numberValue(account.raw.proxy_fallback_origin_id)
  const proxy = proxyId ? proxies.find(item => item.upstreamId === proxyId) : null
  return {
    id: account.view.id,
    name: account.view.name,
    notes: account.view.notes,
    platform: account.view.platform,
    type: account.view.accountType,
    status: account.view.status,
    schedulable: account.view.schedulable,
    priority: numberValue(account.raw.priority) || 0,
    concurrency: account.view.concurrency,
    currentConcurrency: account.view.currentConcurrency,
    rateMultiplier: numberValue(account.raw.rate_multiplier) ?? 1,
    groupIds: ids.map(numberValue).filter((id): id is number => id !== null).map(id => opaqueSub2ApiGroupId(event, id)),
    groupNames: accountGroups(account.raw),
    proxyId: proxyId ? opaqueSub2ApiProxyId(event, proxyId) : null,
    proxyName: proxy?.view.name || null,
    proxyFallbackOriginId: fallbackOriginId ? opaqueSub2ApiProxyId(event, fallbackOriginId) : null,
    proxyEditable: accountProxyEditable(account.raw),
    expiresAt: account.view.expiresAt,
    errorMessage: account.view.errorMessage,
    updatedAt: timestampValue(account.raw.updated_at)
  }
}

export async function listManagedSub2ApiAccounts(event: H3Event) {
  const [accounts, proxies] = await Promise.all([listSub2ApiAccounts(event), listManagedSub2ApiProxies(event, false)])
  return accounts.map(account => ({
    upstreamId: account.upstreamId,
    raw: account.raw,
    view: managedAccountView(event, account, proxies)
  }))
}

export async function resolveManagedSub2ApiAccount(event: H3Event, opaqueId: string) {
  const account = (await listSub2ApiAccounts(event)).find(item => item.view.id === opaqueId)
  if (!account) throw createError({ statusCode: 404, message: 'Sub2API 账号不存在或已变化' })
  return account
}

export async function createManagedSub2ApiOpenAiOAuthAccount(event: H3Event, input: {
  sessionId: string
  code: string
  state: string
  name: string
  concurrency: number
  priority: number
  groupIds: number[]
  proxyId: number | null
  schedulable: boolean
}) {
  const body: UnknownRecord = {
    session_id: input.sessionId,
    code: input.code,
    state: input.state,
    name: input.name,
    concurrency: input.concurrency,
    priority: input.priority,
    group_ids: input.groupIds
  }
  if (input.proxyId) body.proxy_id = input.proxyId
  const created = await sub2ApiAdminFetch<UnknownRecord>(event, '/openai/create-from-oauth', {
    method: 'POST',
    body
  })
  const upstreamId = numberValue(created.id)
  if (!upstreamId) {
    throw createError({
      statusCode: 502,
      message: 'Sub2API 已处理 OAuth 回调，但未返回账号 ID，请刷新列表对账',
      data: { reconciliationRequired: true }
    })
  }
  if (!input.schedulable) {
    try {
      await sub2ApiAdminFetch(event, `/accounts/${upstreamId}/schedulable`, {
        method: 'POST',
        body: { schedulable: false }
      })
    } catch {
      throw createError({
        statusCode: 502,
        message: 'OAuth 账号已创建，但无法确认已退出调度，请刷新列表后立即处理',
        data: { reconciliationRequired: true }
      })
    }
  }
  let refreshed: UnknownRecord
  try {
    refreshed = await sub2ApiAdminFetch<UnknownRecord>(event, `/accounts/${upstreamId}`)
  } catch {
    throw createError({
      statusCode: 502,
      message: 'OAuth 账号已创建，但读取账号结果失败，请刷新列表对账',
      data: { reconciliationRequired: true }
    })
  }
  const internal = accountView(event, refreshed)
  if (!internal) {
    throw createError({
      statusCode: 502,
      message: 'OAuth 账号创建后对账格式异常，请刷新列表确认',
      data: { reconciliationRequired: true }
    })
  }
  return managedAccountView(event, internal)
}

export async function createManagedSub2ApiAccount(event: H3Event, payload: UnknownRecord, activate = true) {
  const desiredGroupIds = Array.isArray(payload.group_ids) ? payload.group_ids : []
  const createPayload = { ...payload, group_ids: [] }
  let created: UnknownRecord
  try {
    created = await sub2ApiAdminFetch<UnknownRecord>(event, '/accounts', { method: 'POST', body: createPayload })
  } catch (error) {
    throw accountImportStepError(error, '创建账号', false)
  }
  const upstreamId = numberValue(created.id)
  if (!upstreamId) {
    throw createError({
      statusCode: 502,
      message: '创建账号失败：Sub2API 未返回账号 ID',
      data: { operationStage: '创建账号', reconciliationRequired: true }
    })
  }
  try {
    await sub2ApiAdminFetch(event, `/accounts/${upstreamId}/schedulable`, { method: 'POST', body: { schedulable: false } })
  } catch (error) {
    try { await sub2ApiAdminFetch(event, `/accounts/${upstreamId}`, { method: 'PUT', body: { status: 'inactive' } }) } catch {
      throw createError({ statusCode: 502, message: '暂停账号调度失败：账号已创建，但无法确认其已退出调度，请立即对账', data: { operationStage: '暂停账号调度', reconciliationRequired: true } })
    }
    throw accountImportStepError(error, '暂停账号调度', true)
  }
  if (desiredGroupIds.length) {
    try {
      await sub2ApiAdminFetch(event, `/accounts/${upstreamId}`, { method: 'PUT', body: { group_ids: desiredGroupIds } })
    } catch (error) {
      throw accountImportStepError(error, '绑定账号分组', true)
    }
  }
  if (activate) {
    try {
      await sub2ApiAdminFetch(event, `/accounts/${upstreamId}/schedulable`, { method: 'POST', body: { schedulable: true } })
    } catch (error) {
      throw accountImportStepError(error, '启用账号调度', true)
    }
  }
  let refreshed: UnknownRecord
  try {
    refreshed = await sub2ApiAdminFetch<UnknownRecord>(event, `/accounts/${upstreamId}`)
  } catch (error) {
    throw accountImportStepError(error, '读取创建结果', true)
  }
  const internal = accountView(event, refreshed)
  if (!internal) {
    throw createError({
      statusCode: 502,
      message: '读取创建结果失败：Sub2API 返回的账号格式异常',
      data: { operationStage: '读取创建结果', reconciliationRequired: true }
    })
  }
  return managedAccountView(event, internal)
}

export async function importManagedSub2ApiData(
  event: H3Event,
  data: UnknownRecord,
  activate = true
) {
  const result = await sub2ApiAdminFetch<UnknownRecord>(event, '/accounts/data', {
    method: 'POST',
    body: { data, skip_default_group_bind: !activate }
  })
  const accountCreated = Math.max(0, numberValue(result.account_created) || 0)
  const accountFailed = Math.max(0, numberValue(result.account_failed) || 0)
  const proxyCreated = Math.max(0, numberValue(result.proxy_created) || 0)
  const proxyReused = Math.max(0, numberValue(result.proxy_reused) || 0)
  const proxyFailed = Math.max(0, numberValue(result.proxy_failed) || 0)
  const errors = Array.isArray(result.errors)
    ? result.errors.slice(0, 50).map((value) => {
        const item = record(value) || {}
        return {
          kind: text(item.kind) || 'unknown',
          name: text(item.name) || null,
          message: redactSensitiveText(text(item.message))
        }
      })
    : []
  return { accountCreated, accountFailed, proxyCreated, proxyReused, proxyFailed, errors, activated: activate }
}

export async function updateManagedSub2ApiAccount(event: H3Event, opaqueId: string, payload: UnknownRecord) {
  const target = await resolveManagedSub2ApiAccount(event, opaqueId)
  if ('proxy_id' in payload && !accountProxyEditable(target.raw)) {
    throw createError({ statusCode: 409, message: '该影子账号继承主账号代理，不能单独修改' })
  }
  const schedulable = typeof payload.schedulable === 'boolean' ? payload.schedulable : null
  const update = { ...payload }
  delete update.schedulable
  if (Object.keys(update).length) await sub2ApiAdminFetch(event, `/accounts/${target.upstreamId}`, { method: 'PUT', body: update })
  if (schedulable !== null) {
    await sub2ApiAdminFetch(event, `/accounts/${target.upstreamId}/schedulable`, { method: 'POST', body: { schedulable } })
  }
  const refreshed = await sub2ApiAdminFetch<UnknownRecord>(event, `/accounts/${target.upstreamId}`)
  const internal = accountView(event, refreshed)
  if (!internal) throw createError({ statusCode: 502, message: 'Sub2API 账号更新后对账失败' })
  return managedAccountView(event, internal)
}

export async function verifyManagedSub2ApiAccount(event: H3Event, opaqueId: string, activate: boolean) {
  const target = await resolveManagedSub2ApiAccount(event, opaqueId)
  const usage = await sub2ApiAdminFetch<UnknownRecord>(event, `/accounts/${target.upstreamId}/usage`, {
    query: { source: 'active', force: 'true' }
  })
  const refreshed = await sub2ApiAdminFetch<UnknownRecord>(event, `/accounts/${target.upstreamId}`)
  const failure = parseSub2ApiActiveUsageFailure(refreshed) || parseSub2ApiActiveUsageFailure(usage)
  if (failure) {
    const failureLabel = `${failure.code ? ` [${failure.code}]` : ''}：${failure.message}`
    if (failure.terminal && booleanValue(refreshed.schedulable, target.view.schedulable)) {
      try {
        await sub2ApiAdminFetch(event, `/accounts/${target.upstreamId}/schedulable`, { method: 'POST', body: { schedulable: false } })
      } catch {
        throw createError({
          statusCode: 502,
          message: `账号验活失败${failureLabel}；同时无法将账号移出调度，请立即手动停用`,
          data: { code: failure.code, verificationFailed: true, disableFailed: true }
        })
      }
    }
    throw createError({
      statusCode: 422,
      message: `账号验活失败${failureLabel}${failure.terminal ? '；已自动移出调度池' : ''}`,
      data: { code: failure.code, verificationFailed: true, disabled: failure.terminal }
    })
  }
  if (activate) await sub2ApiAdminFetch(event, `/accounts/${target.upstreamId}/schedulable`, { method: 'POST', body: { schedulable: true } })
  return { ok: true, activated: activate, message: null }
}

export async function deleteManagedSub2ApiAccount(event: H3Event, opaqueId: string) {
  const target = await resolveManagedSub2ApiAccount(event, opaqueId)
  if (target.view.currentConcurrency > 0) throw createError({ statusCode: 409, message: '账号仍有进行中的请求，不能永久删除' })
  await sub2ApiAdminFetch(event, `/accounts/${target.upstreamId}`, { method: 'DELETE' })
  if ((await listSub2ApiAccounts(event)).some(item => item.upstreamId === target.upstreamId)) {
    throw createError({ statusCode: 502, message: 'Sub2API 返回删除成功，但账号仍然存在' })
  }
  return { deleted: true, name: target.view.name }
}

export async function createManagedSub2ApiGroup(event: H3Event, payload: UnknownRecord) {
  const created = await sub2ApiAdminFetch<UnknownRecord>(event, '/groups', { method: 'POST', body: payload })
  const id = numberValue(created.id)
  if (!id) throw createError({ statusCode: 502, message: 'Sub2API 创建分组后未返回 ID' })
  const group = (await listManagedSub2ApiGroups(event)).find(item => item.upstreamId === id)
  if (!group) throw createError({ statusCode: 502, message: 'Sub2API 分组创建后对账失败' })
  return group.view
}

export async function updateManagedSub2ApiGroup(event: H3Event, opaqueId: string, payload: UnknownRecord) {
  const target = await resolveManagedSub2ApiGroup(event, opaqueId)
  await sub2ApiAdminFetch(event, `/groups/${target.upstreamId}`, { method: 'PUT', body: payload })
  const refreshed = (await listManagedSub2ApiGroups(event)).find(item => item.upstreamId === target.upstreamId)
  if (!refreshed) throw createError({ statusCode: 502, message: 'Sub2API 分组更新后对账失败' })
  return refreshed.view
}

export async function deleteManagedSub2ApiGroup(event: H3Event, opaqueId: string) {
  const groups = await listManagedSub2ApiGroups(event)
  const target = groups.find(item => item.view.id === opaqueId)
  if (!target) throw createError({ statusCode: 404, message: 'Sub2API 分组不存在或已变化' })
  const fallbackReferences = groups.filter(item =>
    numberValue(item.raw.fallback_group_id) === target.upstreamId ||
    numberValue(item.raw.fallback_group_id_on_invalid_request) === target.upstreamId)
  if (target.view.accountCount || fallbackReferences.length) {
    throw createError({ statusCode: 409, message: `分组仍被 ${target.view.accountCount} 个账号和 ${fallbackReferences.length} 个 fallback 引用，不能删除` })
  }
  await sub2ApiAdminFetch(event, `/groups/${target.upstreamId}`, { method: 'DELETE' })
  if ((await listManagedSub2ApiGroups(event)).some(item => item.upstreamId === target.upstreamId)) {
    throw createError({ statusCode: 502, message: 'Sub2API 返回删除成功，但分组仍然存在' })
  }
  return { deleted: true, name: target.view.name }
}
