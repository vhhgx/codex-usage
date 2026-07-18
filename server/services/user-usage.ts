import type { H3Event } from 'h3'
import type {
  UsageRange,
  UserUsageModelRow,
  UserUsageResponse,
  UserUsageSummary,
  UserUsageTimelinePoint
} from '#shared/types/usage'
import { hashApiKey, safeEqual } from '../utils/security'
import { normalizeBaseUrl, requireUpstreamConfig, upstreamError } from '../utils/upstream'

interface AnalyticsPayload {
  generated_at_ms?: unknown
  summary?: Record<string, unknown>
  timeline?: Array<Record<string, unknown>>
  model_stats?: Array<Record<string, unknown>>
}

const keyCache = new Map<string, { expiresAt: number; keys: string[] }>()

function numberValue(value: unknown) {
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) ? result : 0
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function resolveRange(range: UsageRange) {
  const now = new Date()
  const to = now.getTime()
  if (range === 'today') {
    const fromDate = new Date(now)
    fromDate.setHours(0, 0, 0, 0)
    return { from: fromDate.getTime(), to, granularity: 'hour' as const }
  }
  const days = range === '7d' ? 7 : 30
  return {
    from: to - days * 24 * 60 * 60 * 1000,
    to,
    granularity: 'day' as const
  }
}

async function loadConfiguredApiKeys(event: H3Event) {
  const config = requireUpstreamConfig(event, ['cpaBaseUrl', 'cpaManagementKey'])
  const base = normalizeBaseUrl(config.cpaBaseUrl).replace(/\/v0\/management$/i, '')
  const cacheKey = base
  const cached = keyCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.keys

  try {
    const response = await $fetch<Record<string, unknown>>(`${base}/v0/management/api-keys`, {
      headers: { Authorization: `Bearer ${config.cpaManagementKey}` },
      timeout: 15_000
    })
    const raw = response['api-keys'] ?? response.apiKeys
    const keys = Array.isArray(raw)
      ? raw.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    keyCache.set(cacheKey, { keys, expiresAt: Date.now() + 20_000 })
    return keys
  } catch (error) {
    upstreamError(error, '无法读取 CPA 客户端 API Keys')
  }
}

async function assertConfiguredApiKey(event: H3Event, apiKey: string) {
  const keys = await loadConfiguredApiKeys(event)
  const normalized = apiKey.trim()
  const valid = keys.reduce((matched, candidate) => safeEqual(normalized, candidate) || matched, false)
  if (!valid) {
    throw createError({ statusCode: 404, message: '密钥无效或暂无可查询数据' })
  }
}

function mapSummary(input: Record<string, unknown> = {}): UserUsageSummary {
  return {
    calls: numberValue(input.total_calls),
    successCalls: numberValue(input.success_calls),
    failedCalls: numberValue(input.failure_calls),
    successRate: numberValue(input.success_rate),
    inputTokens: numberValue(input.input_tokens),
    outputTokens: numberValue(input.output_tokens),
    reasoningTokens: numberValue(input.reasoning_tokens),
    cachedTokens: numberValue(input.cached_tokens),
    totalTokens: numberValue(input.total_tokens),
    estimatedCost: numberValue(input.total_cost),
    averageLatencyMs: nullableNumber(input.average_latency_ms)
  }
}

function mapTimeline(items: AnalyticsPayload['timeline']): UserUsageTimelinePoint[] {
  return (Array.isArray(items) ? items : []).map((item) => ({
    timestamp: numberValue(item.bucket_ms),
    label: String(item.label || ''),
    calls: numberValue(item.calls),
    totalTokens: numberValue(item.total_tokens ?? item.tokens),
    estimatedCost: numberValue(item.cost),
    successRate: nullableNumber(item.success_rate)
  }))
}

function mapModels(items: AnalyticsPayload['model_stats']): UserUsageModelRow[] {
  return (Array.isArray(items) ? items : []).map((item) => ({
    model: String(item.model || 'unknown'),
    calls: numberValue(item.calls),
    successCalls: numberValue(item.success_calls),
    failedCalls: numberValue(item.failure_calls),
    successRate: numberValue(item.success_rate),
    inputTokens: numberValue(item.input_tokens),
    outputTokens: numberValue(item.output_tokens),
    reasoningTokens: numberValue(item.reasoning_tokens),
    cachedTokens: numberValue(item.cached_tokens),
    totalTokens: numberValue(item.total_tokens),
    estimatedCost: numberValue(item.cost)
  }))
}

export async function queryUserUsage(
  event: H3Event,
  apiKey: string,
  range: UsageRange
): Promise<UserUsageResponse> {
  await assertConfiguredApiKey(event, apiKey)
  const config = requireUpstreamConfig(event, ['cpampBaseUrl', 'cpampAdminKey'])
  const base = normalizeBaseUrl(config.cpampBaseUrl).replace(/\/v0\/management$/i, '')
  const resolved = resolveRange(range)
  try {
    const payload = await $fetch<AnalyticsPayload>(
      `${base}/v0/management/monitoring/analytics`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.cpampAdminKey}` },
        body: {
          from_ms: resolved.from,
          to_ms: resolved.to,
          now_ms: resolved.to,
          time_zone: 'Asia/Shanghai',
          filters: { api_key_hashes: [hashApiKey(apiKey)] },
          include: {
            summary: true,
            timeline: true,
            model_stats: true,
            granularity: resolved.granularity
          }
        },
        timeout: 30_000
      }
    )
    return {
      range,
      from: resolved.from,
      to: resolved.to,
      summary: mapSummary(payload.summary),
      timeline: mapTimeline(payload.timeline),
      models: mapModels(payload.model_stats),
      generatedAt: numberValue(payload.generated_at_ms) || Date.now()
    }
  } catch (error) {
    upstreamError(error, '无法查询 CPA Manager Plus 用量数据')
  }
}
