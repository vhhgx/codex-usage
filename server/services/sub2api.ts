import type { H3Event } from 'h3'
import type {
  UsageRange,
  UserQuotaLimit,
  UserQuotaSummary,
  UserUsageModelRow,
  UserUsageResponse,
  UserUsageSummary,
  UserUsageTimelinePoint
} from '#shared/types/usage'
import { normalizeBaseUrl, requireUpstreamConfig } from '../utils/upstream'

type UnknownRecord = Record<string, unknown>

interface ResolvedRange {
  from: number
  to: number
  startDate: string
  endDate: string
  days: number
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function timestampValue(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(stringValue(value))
  return Number.isNaN(parsed) ? null : parsed
}

function nonNegative(value: unknown) {
  return Math.max(0, numberValue(value) || 0)
}

function formatDate(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function resolveRange(range: UsageRange, now = new Date()): ResolvedRange {
  const to = now.getTime()
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const from = range === 'today'
    ? new Date(`${formatDate(now)}T00:00:00+08:00`).getTime()
    : to - days * 24 * 60 * 60 * 1000

  return {
    from,
    to,
    startDate: formatDate(new Date(from)),
    endDate: formatDate(now),
    days
  }
}

function mapDailyUsage(value: unknown): UserUsageTimelinePoint[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const item = record(raw)
    if (!item) return []
    const date = stringValue(item.date)
    return [{
      timestamp: date ? new Date(`${date}T00:00:00+08:00`).getTime() : 0,
      label: date,
      calls: nonNegative(item.requests),
      totalTokens: nonNegative(item.total_tokens),
      estimatedCost: nonNegative(item.actual_cost ?? item.cost),
      successRate: null
    }]
  })
}

function mapModels(value: unknown): UserUsageModelRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const item = record(raw)
    if (!item) return []
    return [{
      model: stringValue(item.model) || 'unknown',
      calls: nonNegative(item.requests),
      successCalls: null,
      failedCalls: null,
      successRate: null,
      inputTokens: nonNegative(item.input_tokens),
      outputTokens: nonNegative(item.output_tokens),
      reasoningTokens: 0,
      cachedTokens: nonNegative(item.cache_creation_tokens) + nonNegative(item.cache_read_tokens),
      totalTokens: nonNegative(item.total_tokens),
      estimatedCost: nonNegative(item.actual_cost ?? item.cost)
    }]
  })
}

function addSummary(left: UserUsageSummary, item: UserUsageTimelinePoint) {
  left.calls += item.calls
  left.totalTokens += item.totalTokens
  left.estimatedCost += item.estimatedCost
  return left
}

function emptySummary(): UserUsageSummary {
  return {
    calls: 0,
    successCalls: null,
    failedCalls: null,
    successRate: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    averageLatencyMs: null
  }
}

function mapSummary(
  payload: UnknownRecord,
  range: UsageRange,
  timeline: UserUsageTimelinePoint[],
  models: UserUsageModelRow[]
) {
  const summary = timeline.reduce(addSummary, emptySummary())
  const dailyRows = Array.isArray(payload.daily_usage)
    ? payload.daily_usage.map(record).filter((item): item is UnknownRecord => Boolean(item))
    : []
  const sourceRows = models.length ? models : []
  if (dailyRows.length) {
    summary.inputTokens = dailyRows.reduce((total, item) => total + nonNegative(item.input_tokens), 0)
    summary.outputTokens = dailyRows.reduce((total, item) => total + nonNegative(item.output_tokens), 0)
    summary.cachedTokens = dailyRows.reduce(
      (total, item) => total + nonNegative(item.cache_write_tokens ?? item.cache_creation_tokens) + nonNegative(item.cache_read_tokens),
      0
    )
  } else if (sourceRows.length) {
    summary.inputTokens = sourceRows.reduce((total, item) => total + item.inputTokens, 0)
    summary.outputTokens = sourceRows.reduce((total, item) => total + item.outputTokens, 0)
    summary.cachedTokens = sourceRows.reduce((total, item) => total + item.cachedTokens, 0)
    summary.reasoningTokens = sourceRows.reduce((total, item) => total + item.reasoningTokens, 0)
  }
  if (!timeline.length && sourceRows.length) {
    summary.calls = sourceRows.reduce((total, item) => total + item.calls, 0)
    summary.totalTokens = sourceRows.reduce((total, item) => total + item.totalTokens, 0)
    summary.estimatedCost = sourceRows.reduce((total, item) => total + item.estimatedCost, 0)
  }

  const usage = record(payload.usage)
  const period = range === 'today' ? record(usage?.today) : null
  if (!timeline.length && period) {
    summary.calls = nonNegative(period.requests)
    summary.inputTokens = nonNegative(period.input_tokens)
    summary.outputTokens = nonNegative(period.output_tokens)
    summary.cachedTokens = nonNegative(period.cache_creation_tokens) + nonNegative(period.cache_read_tokens)
    summary.totalTokens = nonNegative(period.total_tokens)
    summary.estimatedCost = nonNegative(period.actual_cost ?? period.cost)
  }
  summary.averageLatencyMs = numberValue(usage?.average_duration_ms)
  return summary
}

function quotaLimit(
  id: string,
  label: string,
  raw: UnknownRecord,
  resetAt: unknown = null
): UserQuotaLimit | null {
  const limit = numberValue(raw.limit)
  if (limit === null || limit <= 0) return null
  const used = nonNegative(raw.used)
  return {
    id,
    label,
    used,
    limit,
    remaining: Math.max(0, numberValue(raw.remaining) ?? limit - used),
    resetAt: timestampValue(raw.reset_at ?? resetAt)
  }
}

export function parseSub2ApiQuota(payload: UnknownRecord): UserQuotaSummary {
  const rawMode = stringValue(payload.mode)
  const quota = record(payload.quota)
  const subscription = record(payload.subscription)
  const limits: UserQuotaLimit[] = []

  if (quota) {
    const limit = quotaLimit('total', '总额度', quota)
    if (limit) limits.push(limit)
  }

  const rateLimitLabels: Record<string, string> = {
    '5h': '5 小时限额',
    '1d': '每日限额',
    '7d': '7 天限额'
  }
  if (Array.isArray(payload.rate_limits)) {
    payload.rate_limits.forEach((raw, index) => {
      const item = record(raw)
      if (!item) return
      const window = stringValue(item.window) || `window-${index}`
      const limit = quotaLimit(`rate-${window}`, rateLimitLabels[window] || `${window} 限额`, item)
      if (limit) limits.push(limit)
    })
  }

  if (subscription) {
    const subscriptionLimits = [
      ['daily', '每日限额', 'daily_usage_usd', 'daily_limit_usd'],
      ['weekly', '每周限额', 'weekly_usage_usd', 'weekly_limit_usd'],
      ['monthly', '每月限额', 'monthly_usage_usd', 'monthly_limit_usd']
    ] as const
    subscriptionLimits.forEach(([id, label, usedKey, limitKey]) => {
      const limit = quotaLimit(id, label, {
        used: subscription[usedKey],
        limit: subscription[limitKey]
      })
      if (limit) limits.push(limit)
    })
  }

  const remainingRaw = numberValue(payload.remaining ?? quota?.remaining)
  const balance = numberValue(payload.balance)
  const mode = rawMode === 'quota_limited'
    ? 'quota_limited'
    : subscription
      ? 'subscription'
      : 'balance'

  return {
    mode,
    isValid: payload.isValid !== false,
    status: stringValue(payload.status) || 'active',
    planName: stringValue(payload.planName) || (mode === 'balance' ? '钱包余额' : 'Sub2API'),
    unit: stringValue(payload.unit) || stringValue(quota?.unit) || 'USD',
    remaining: remainingRaw !== null && remainingRaw >= 0 ? remainingRaw : balance,
    balance,
    expiresAt: timestampValue(payload.expires_at ?? subscription?.expires_at),
    daysUntilExpiry: numberValue(payload.days_until_expiry),
    limits
  }
}

export function parseSub2ApiUsagePayload(
  payload: UnknownRecord,
  range: UsageRange,
  now = new Date()
): UserUsageResponse {
  const resolved = resolveRange(range, now)
  const timeline = mapDailyUsage(payload.daily_usage)
  const models = mapModels(payload.model_stats)
  return {
    source: 'sub2api',
    range,
    from: resolved.from,
    to: resolved.to,
    summary: mapSummary(payload, range, timeline, models),
    timeline,
    models,
    quota: parseSub2ApiQuota(payload),
    generatedAt: now.getTime()
  }
}

function sub2apiError(error: unknown): never {
  const response = (error as { response?: { status?: number }; statusCode?: number })?.response
  const status = Number(response?.status || (error as { statusCode?: number })?.statusCode || 0)
  const data = record((error as { data?: unknown })?.data)
  const nestedError = record(data?.error)
  const message = stringValue(nestedError?.message ?? data?.message)

  throw createError({
    statusCode: status === 401 || status === 403 ? 404 : status >= 400 && status < 500 ? status : 502,
    message: status === 401 || status === 403
      ? '密钥无效或无权查询 Sub2API 额度'
      : message || '无法查询 Sub2API 额度'
  })
}

export async function querySub2ApiUsage(
  event: H3Event,
  apiKey: string,
  range: UsageRange
): Promise<UserUsageResponse> {
  const config = requireUpstreamConfig(event, ['sub2apiBaseUrl'])
  const base = normalizeBaseUrl(config.sub2apiBaseUrl).replace(/\/v1$/i, '')
  const resolved = resolveRange(range)
  try {
    const payload = await $fetch<UnknownRecord>(`${base}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      query: {
        start_date: resolved.startDate,
        end_date: resolved.endDate,
        days: resolved.days,
        timezone: 'Asia/Shanghai'
      },
      timeout: 30_000
    })
    const normalized = record(payload)
    if (!normalized) {
      throw createError({ statusCode: 502, message: 'Sub2API 额度响应格式不正确' })
    }
    return parseSub2ApiUsagePayload(normalized, range)
  } catch (error) {
    sub2apiError(error)
  }
}
