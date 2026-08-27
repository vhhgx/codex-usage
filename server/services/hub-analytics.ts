import { and, asc, count, desc, eq, gt, gte, ilike, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { HubOverview, RequestLogView } from '#shared/types/hub'
import { useDatabase } from '../db'
import { channels, groups, hubKeys, requestAttempts, requestLogs, usageRollups, users } from '../db/schema'
import { readEncryptedBody } from '../utils/object-storage'
import { getHubSettings } from './hub-settings'
import { startOfZoned } from '../utils/time-zone'
import { channelCircuitState } from './hub-routing'

const ANALYTICS_RANGES = new Set(['today', '24h', 'week', 'month', 'year', 'all', 'custom'])
const REQUEST_STATUSES = new Set(['pending', 'success', 'error', 'stream_aborted'])
const REQUEST_RESOURCE_TYPES = new Set(['subscription', 'user_relay', 'private_pool', 'unresolved'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateDimensionFilters(query: Record<string, string | undefined>) {
  if (query.keyId && !UUID_PATTERN.test(query.keyId)) throw createError({ statusCode: 400, message: 'Hub Key 筛选值格式不正确' })
  if (query.channelId && !UUID_PATTERN.test(query.channelId)) throw createError({ statusCode: 400, message: '渠道筛选值格式不正确' })
  if (query.resourceId && !UUID_PATTERN.test(query.resourceId)) throw createError({ statusCode: 400, message: '资源筛选值格式不正确' })
  if (query.resourceType && !REQUEST_RESOURCE_TYPES.has(query.resourceType)) throw createError({ statusCode: 400, message: '资源类型筛选值不正确' })
  if (query.status && !REQUEST_STATUSES.has(query.status)) throw createError({ statusCode: 400, message: '请求状态筛选值不正确' })
}

function dateFilter(value: string | undefined, label: string) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw createError({ statusCode: 400, message: `${label}格式不正确` })
  return date
}

export function resolveAnalyticsRange(query: Record<string, string | undefined>, timezone = 'Asia/Shanghai') {
  const now = new Date()
  const preset = query.range || '24h'
  if (!ANALYTICS_RANGES.has(preset)) throw createError({ statusCode: 400, message: '统计时间范围不正确' })
  if (preset === 'custom' && (!query.from || !query.to)) throw createError({ statusCode: 400, message: '自定义统计需要开始和结束时间' })
  const from = preset === 'today' ? startOfZoned(now, 'day', timezone)
    : preset === '24h' ? new Date(now.getTime() - 24 * 3600_000)
      : preset === 'week' ? startOfZoned(now, 'week', timezone)
        : preset === 'month' ? startOfZoned(now, 'month', timezone)
          : preset === 'year' ? startOfZoned(now, 'year', timezone)
            : preset === 'all' ? new Date(0)
              : query.from ? new Date(query.from) : new Date(now.getTime() - 24 * 3600_000)
  const to = preset === 'custom' && query.to ? new Date(query.to) : now
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw createError({ statusCode: 400, message: '统计时间范围不正确' })
  }
  return { from, to, preset }
}

function number(value: unknown) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

export function requestResourceFallback(type: 'subscription' | 'user_relay' | 'private_pool' | 'unresolved') {
  if (type === 'subscription') return '当前套餐'
  if (type === 'user_relay') return '个人中转'
  if (type === 'private_pool') return '我的专属号池'
  return '未选路'
}

function rollupP95(value: Record<string, unknown> | undefined) {
  const count = number(value?.latencyCount)
  if (!count) return null
  const target = count * 0.95
  const buckets: Array<[number, unknown]> = [
    [100, value?.latencyLe100], [250, value?.latencyLe250], [500, value?.latencyLe500],
    [1000, value?.latencyLe1000], [2500, value?.latencyLe2500], [5000, value?.latencyLe5000],
    [10000, value?.latencyLe10000]
  ]
  return buckets.find(([, bucketCount]) => number(bucketCount) >= target)?.[0] || 10000
}

export async function overview(event: H3Event, query: Record<string, string | undefined>): Promise<HubOverview> {
  validateDimensionFilters(query)
  const db = useDatabase(event)
  const settings = await getHubSettings(event)
  const range = resolveAnalyticsRange(query, settings.timezone)
  if (range.preset === 'all') return overviewAllTime(event, query)
  const duration = range.to.getTime() - range.from.getTime()
  const retentionStart = Date.now() - settings.metadataRetentionDays * 86400_000
  const useDailyRollups = range.from.getTime() < retentionStart || duration > 3 * 86400_000 && (
    range.preset === 'month' || range.preset === 'year'
  )
  if (useDailyRollups) return overviewRollupRange(event, query, range)
  const condition = and(
    gte(requestLogs.createdAt, range.from),
    lte(requestLogs.createdAt, range.to),
    query.keyId ? eq(requestLogs.keyId, query.keyId) : undefined,
    query.model ? eq(requestLogs.requestedModel, query.model) : undefined,
    query.channelId ? eq(requestLogs.channelId, query.channelId) : undefined,
    query.endpoint ? eq(requestLogs.endpoint, query.endpoint) : undefined,
    query.status ? eq(requestLogs.status, query.status as 'pending' | 'success' | 'error' | 'stream_aborted') : undefined
  )
  const [totals] = await db.select({
    requests: count(),
    successes: sql<number>`count(*) filter (where ${requestLogs.status} = 'success')`,
    failures: sql<number>`count(*) filter (where ${requestLogs.status} != 'success')`,
    totalTokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    inputTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens}), 0)`,
    cacheReadTokens: sql<number>`coalesce(sum(${requestLogs.cachedTokens}), 0)`,
    cacheCreationTokens: sql<number>`coalesce(sum(${requestLogs.cacheCreationTokens}), 0)`,
    cacheHitRequests: sql<number>`count(*) filter (where ${requestLogs.cachedTokens} > 0)`,
    cacheEligibleRequests: sql<number>`count(*) filter (where ${requestLogs.inputTokens} > 0)`,
    affinityReuses: sql<number>`count(*) filter (where ${requestLogs.cacheAffinityReused} = true)`,
    affinityEligibleRequests: sql<number>`count(*) filter (where ${requestLogs.requestedModel} is not null)`,
    affinityFailovers: sql<number>`count(*) filter (where ${requestLogs.cacheAffinityReused} = true and ${requestLogs.failoverCount} > 0)`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`,
    duration: sql<number>`coalesce(avg(${requestLogs.durationMs}), 0)`,
    p95: sql<number>`percentile_cont(0.95) within group (order by ${requestLogs.durationMs}) filter (where ${requestLogs.durationMs} is not null)`,
    p95FirstByte: sql<number>`percentile_cont(0.95) within group (order by ${requestLogs.firstByteMs}) filter (where ${requestLogs.firstByteMs} is not null)`,
    streamingRequests: sql<number>`count(*) filter (where ${requestLogs.streaming} = true)`,
    streamAborts: sql<number>`count(*) filter (where ${requestLogs.status} = 'stream_aborted')`,
    failovers: sql<number>`coalesce(sum(${requestLogs.failoverCount}), 0)`
  }).from(requestLogs).where(condition)
  const granularity = duration <= 3 * 24 * 3600_000 ? 'hour' : 'day'
  const bucket = granularity === 'hour'
    ? sql<number>`extract(epoch from (date_trunc('hour', ${requestLogs.createdAt} at time zone ${settings.timezone}) at time zone ${settings.timezone})) * 1000`
    : sql<number>`extract(epoch from (date_trunc('day', ${requestLogs.createdAt} at time zone ${settings.timezone}) at time zone ${settings.timezone})) * 1000`
  const timelineRows = await db.select({
    bucket,
    requests: count(),
    tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`,
    failures: sql<number>`count(*) filter (where ${requestLogs.status} != 'success')`
  }).from(requestLogs).where(condition).groupBy(sql`1`).orderBy(asc(sql`1`))
  const modelRows = await db.select({
    model: requestLogs.requestedModel,
    requests: count(),
    tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).where(condition).groupBy(requestLogs.requestedModel).orderBy(desc(count())).limit(20)
  const channelRows = await db.select({
    id: channels.id,
    name: channels.name,
    requests: count(),
    failures: sql<number>`count(*) filter (where ${requestLogs.status} != 'success')`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).leftJoin(channels, eq(requestLogs.channelId, channels.id)).where(condition)
    .groupBy(channels.id, channels.name).orderBy(desc(count())).limit(20)
  const keyRows = await db.select({
    id: hubKeys.id,
    name: hubKeys.name,
    requests: count(),
    tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).leftJoin(hubKeys, eq(requestLogs.keyId, hubKeys.id)).where(condition)
    .groupBy(hubKeys.id, hubKeys.name).orderBy(desc(count())).limit(20)
  const userRows = await db.select({
    id: users.id, name: users.displayName, username: users.username, requests: count(),
    tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).leftJoin(users, eq(requestLogs.userId, users.id)).where(condition)
    .groupBy(users.id, users.displayName, users.username).orderBy(desc(count())).limit(20)
  const groupRows = await db.select({
    id: groups.id, name: groups.name, requests: count(),
    tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).leftJoin(groups, eq(requestLogs.groupId, groups.id)).where(condition)
    .groupBy(groups.id, groups.name).orderBy(desc(count())).limit(20)
  const endpointRows = await db.select({
    endpoint: requestLogs.endpoint,
    requests: count(),
    failures: sql<number>`count(*) filter (where ${requestLogs.status} != 'success')`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).where(condition).groupBy(requestLogs.endpoint).orderBy(desc(count()))
  const statusRows = await db.select({
    status: requestLogs.status,
    requests: count(),
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`
  }).from(requestLogs).where(condition).groupBy(requestLogs.status).orderBy(desc(count()))
  const [keyCount] = await db.select({ value: count() }).from(hubKeys).where(and(
    eq(hubKeys.status, 'active'),
    or(isNull(hubKeys.expiresAt), gt(hubKeys.expiresAt, new Date()))
  ))
  const [[userCount], [groupCount]] = await Promise.all([
    db.select({ value: count() }).from(users).where(eq(users.status, 'active')),
    db.select({ value: count() }).from(groups).where(eq(groups.status, 'active'))
  ])
  const healthyChannelRows = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.enabled, true), eq(channels.healthStatus, 'healthy')))
  const healthyChannels = (await Promise.all(healthyChannelRows.map(async row =>
    await channelCircuitState(event, row.id) === 'closed'
  ))).filter(Boolean).length
  const requests = number(totals?.requests)
  const successes = number(totals?.successes)
  const streamingRequests = number(totals?.streamingRequests)
  const inputTokens = number(totals?.inputTokens)
  const cacheEligibleRequests = number(totals?.cacheEligibleRequests)
  const affinityEligibleRequests = number(totals?.affinityEligibleRequests)
  return {
    range: { from: range.from.getTime(), to: range.to.getTime(), preset: range.preset },
    totals: {
      requests,
      successes,
      failures: number(totals?.failures),
      totalTokens: number(totals?.totalTokens),
      cost: number(totals?.cost),
      averageLatencyMs: requests ? number(totals?.duration) : null,
      p95LatencyMs: requests ? number(totals?.p95) : null,
      p95FirstByteMs: number(totals?.p95FirstByte) || null,
      streamAbortRate: streamingRequests ? number(totals?.streamAborts) / streamingRequests * 100 : null,
      successRate: requests ? successes / requests * 100 : null,
      failovers: number(totals?.failovers),
      cacheReadTokens: number(totals?.cacheReadTokens),
      cacheCreationTokens: number(totals?.cacheCreationTokens),
      tokenCacheHitRate: inputTokens ? number(totals?.cacheReadTokens) / inputTokens * 100 : null,
      requestCacheHitRate: cacheEligibleRequests ? number(totals?.cacheHitRequests) / cacheEligibleRequests * 100 : null,
      affinityReuseRate: affinityEligibleRequests ? number(totals?.affinityReuses) / affinityEligibleRequests * 100 : null,
      affinityFailovers: number(totals?.affinityFailovers)
    },
    timeline: timelineRows.map(row => ({ timestamp: number(row.bucket), requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost), failures: number(row.failures) })),
    models: modelRows.map(row => ({ model: row.model || 'unknown', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    endpoints: endpointRows.map(row => ({ endpoint: row.endpoint, requests: number(row.requests), failures: number(row.failures), cost: number(row.cost) })),
    channels: channelRows.map(row => ({ id: row.id || 'unknown', name: row.name || '未知渠道', requests: number(row.requests), failures: number(row.failures), cost: number(row.cost) })),
    keys: keyRows.map(row => ({ id: row.id || 'unknown', name: row.name || '已删除 Key', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    statuses: statusRows.map(row => ({ status: row.status, requests: number(row.requests), cost: number(row.cost) })),
    users: userRows.filter(row => row.id).map(row => ({ id: row.id!, name: row.name || row.username || '已删除用户', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    groups: groupRows.filter(row => row.id).map(row => ({ id: row.id!, name: row.name || '已删除分组', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    activeKeys: number(keyCount?.value),
    activeUsers: number(userCount?.value),
    activeGroups: number(groupCount?.value),
    healthyChannels
  }
}

async function overviewAllTime(event: H3Event, query: Record<string, string | undefined>): Promise<HubOverview> {
  return overviewRollupRange(event, query)
}

async function overviewRollupRange(
  event: H3Event,
  query: Record<string, string | undefined>,
  requestedRange?: { from: Date; to: Date; preset: string }
): Promise<HubOverview> {
  const db = useDatabase(event)
  const settings = await getHubSettings(event)
  const rollupFrom = requestedRange ? startOfZoned(requestedRange.from, 'day', settings.timezone) : null
  const rollupTo = requestedRange ? startOfZoned(requestedRange.to, 'day', settings.timezone) : null
  const condition = and(
    eq(usageRollups.granularity, 'day'),
    rollupFrom ? gte(usageRollups.bucketStart, rollupFrom) : undefined,
    rollupTo ? lte(usageRollups.bucketStart, rollupTo) : undefined,
    query.keyId ? eq(usageRollups.keyId, query.keyId) : undefined,
    query.model ? eq(usageRollups.model, query.model) : undefined,
    query.channelId ? eq(usageRollups.channelId, query.channelId) : undefined,
    query.endpoint ? eq(usageRollups.endpoint, query.endpoint) : undefined,
    query.status ? eq(usageRollups.status, query.status) : undefined
  )
  const [totals] = await db.select({
    requests: sql<number>`coalesce(sum(${usageRollups.requests}), 0)`,
    successes: sql<number>`coalesce(sum(${usageRollups.successes}), 0)`,
    failures: sql<number>`coalesce(sum(${usageRollups.failures}), 0)`,
    totalTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`,
    inputTokens: sql<number>`coalesce(sum(${usageRollups.inputTokens}), 0)`,
    cacheReadTokens: sql<number>`coalesce(sum(${usageRollups.cachedTokens}), 0)`,
    cacheCreationTokens: sql<number>`coalesce(sum(${usageRollups.cacheCreationTokens}), 0)`,
    cacheHitRequests: sql<number>`coalesce(sum(${usageRollups.cacheHitRequests}), 0)`,
    cacheEligibleRequests: sql<number>`coalesce(sum(${usageRollups.cacheEligibleRequests}), 0)`,
    affinityReuses: sql<number>`coalesce(sum(${usageRollups.affinityReuses}), 0)`,
    affinityEligibleRequests: sql<number>`coalesce(sum(${usageRollups.requests}), 0)`,
    affinityFailovers: sql<number>`coalesce(sum(${usageRollups.affinityFailovers}), 0)`,
    cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)`,
    duration: sql<number>`coalesce(sum(${usageRollups.durationMs}), 0)`,
    latencyCount: sql<number>`coalesce(sum(${usageRollups.latencyCount}), 0)`,
    latencyLe100: sql<number>`coalesce(sum(${usageRollups.latencyLe100}), 0)`,
    latencyLe250: sql<number>`coalesce(sum(${usageRollups.latencyLe250}), 0)`,
    latencyLe500: sql<number>`coalesce(sum(${usageRollups.latencyLe500}), 0)`,
    latencyLe1000: sql<number>`coalesce(sum(${usageRollups.latencyLe1000}), 0)`,
    latencyLe2500: sql<number>`coalesce(sum(${usageRollups.latencyLe2500}), 0)`,
    latencyLe5000: sql<number>`coalesce(sum(${usageRollups.latencyLe5000}), 0)`,
    latencyLe10000: sql<number>`coalesce(sum(${usageRollups.latencyLe10000}), 0)`,
    failovers: sql<number>`coalesce(sum(${usageRollups.failovers}), 0)`
  }).from(usageRollups).where(condition)
  const timelineRows = await db.select({
    bucket: usageRollups.bucketStart,
    requests: sql<number>`sum(${usageRollups.requests})`,
    tokens: sql<number>`sum(${usageRollups.totalTokens})`,
    cost: sql<string>`sum(${usageRollups.cost})`,
    failures: sql<number>`sum(${usageRollups.failures})`
  }).from(usageRollups).where(condition).groupBy(usageRollups.bucketStart).orderBy(asc(usageRollups.bucketStart))
  const modelRows = await db.select({
    model: usageRollups.model,
    requests: sql<number>`sum(${usageRollups.requests})`,
    tokens: sql<number>`sum(${usageRollups.totalTokens})`,
    cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).where(condition).groupBy(usageRollups.model).orderBy(desc(sql`sum(${usageRollups.requests})`)).limit(20)
  const channelRows = await db.select({
    id: channels.id,
    name: channels.name,
    requests: sql<number>`sum(${usageRollups.requests})`,
    failures: sql<number>`sum(${usageRollups.failures})`,
    cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).leftJoin(channels, eq(usageRollups.channelId, channels.id)).where(condition)
    .groupBy(channels.id, channels.name).orderBy(desc(sql`sum(${usageRollups.requests})`)).limit(20)
  const keyRows = await db.select({
    id: hubKeys.id,
    name: hubKeys.name,
    requests: sql<number>`sum(${usageRollups.requests})`,
    tokens: sql<number>`sum(${usageRollups.totalTokens})`,
    cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).leftJoin(hubKeys, eq(usageRollups.keyId, hubKeys.id)).where(condition)
    .groupBy(hubKeys.id, hubKeys.name).orderBy(desc(sql`sum(${usageRollups.requests})`)).limit(20)
  const userRows = await db.select({
    id: users.id, name: users.displayName, username: users.username,
    requests: sql<number>`sum(${usageRollups.requests})`, tokens: sql<number>`sum(${usageRollups.totalTokens})`, cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).leftJoin(users, eq(usageRollups.userId, users.id)).where(condition)
    .groupBy(users.id, users.displayName, users.username).orderBy(desc(sql`sum(${usageRollups.requests})`)).limit(20)
  const groupRows = await db.select({
    id: groups.id, name: groups.name, requests: sql<number>`sum(${usageRollups.requests})`,
    tokens: sql<number>`sum(${usageRollups.totalTokens})`, cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).leftJoin(groups, eq(usageRollups.groupId, groups.id)).where(condition)
    .groupBy(groups.id, groups.name).orderBy(desc(sql`sum(${usageRollups.requests})`)).limit(20)
  const endpointRows = await db.select({
    endpoint: usageRollups.endpoint,
    requests: sql<number>`sum(${usageRollups.requests})`,
    failures: sql<number>`sum(${usageRollups.failures})`,
    cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).where(condition).groupBy(usageRollups.endpoint).orderBy(desc(sql`sum(${usageRollups.requests})`))
  const statusRows = await db.select({
    status: usageRollups.status,
    requests: sql<number>`sum(${usageRollups.requests})`,
    cost: sql<string>`sum(${usageRollups.cost})`
  }).from(usageRollups).where(condition).groupBy(usageRollups.status).orderBy(desc(sql`sum(${usageRollups.requests})`))
  const [keyCount] = await db.select({ value: count() }).from(hubKeys).where(and(
    eq(hubKeys.status, 'active'),
    or(isNull(hubKeys.expiresAt), gt(hubKeys.expiresAt, new Date()))
  ))
  const [[userCount], [groupCount]] = await Promise.all([
    db.select({ value: count() }).from(users).where(eq(users.status, 'active')),
    db.select({ value: count() }).from(groups).where(eq(groups.status, 'active'))
  ])
  const healthyChannelRows = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.enabled, true), eq(channels.healthStatus, 'healthy')))
  const healthyChannels = (await Promise.all(healthyChannelRows.map(async row =>
    await channelCircuitState(event, row.id) === 'closed'
  ))).filter(Boolean).length
  const requests = number(totals?.requests)
  const successes = number(totals?.successes)
  const inputTokens = number(totals?.inputTokens)
  const cacheEligibleRequests = number(totals?.cacheEligibleRequests)
  const affinityEligibleRequests = number(totals?.affinityEligibleRequests)
  const from = requestedRange?.from.getTime() ?? timelineRows[0]?.bucket?.getTime() ?? Date.now()
  const to = requestedRange?.to.getTime() ?? Date.now()
  return {
    range: { from, to, preset: requestedRange?.preset || 'all' },
    totals: { requests, successes, failures: number(totals?.failures), totalTokens: number(totals?.totalTokens), cost: number(totals?.cost), averageLatencyMs: requests ? number(totals?.duration) / requests : null, p95LatencyMs: rollupP95(totals), p95FirstByteMs: null, streamAbortRate: null, successRate: requests ? successes / requests * 100 : null, failovers: number(totals?.failovers), cacheReadTokens: number(totals?.cacheReadTokens), cacheCreationTokens: number(totals?.cacheCreationTokens), tokenCacheHitRate: inputTokens ? number(totals?.cacheReadTokens) / inputTokens * 100 : null, requestCacheHitRate: cacheEligibleRequests ? number(totals?.cacheHitRequests) / cacheEligibleRequests * 100 : null, affinityReuseRate: affinityEligibleRequests ? number(totals?.affinityReuses) / affinityEligibleRequests * 100 : null, affinityFailovers: number(totals?.affinityFailovers) },
    timeline: timelineRows.map(row => ({ timestamp: row.bucket.getTime(), requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost), failures: number(row.failures) })),
    models: modelRows.map(row => ({ model: row.model || 'unknown', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    endpoints: endpointRows.map(row => ({ endpoint: row.endpoint, requests: number(row.requests), failures: number(row.failures), cost: number(row.cost) })),
    channels: channelRows.map(row => ({ id: row.id || 'unknown', name: row.name || '未知渠道', requests: number(row.requests), failures: number(row.failures), cost: number(row.cost) })),
    keys: keyRows.map(row => ({ id: row.id || 'unknown', name: row.name || '已删除 Key', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    statuses: statusRows.map(row => ({ status: row.status, requests: number(row.requests), cost: number(row.cost) })),
    users: userRows.filter(row => row.id).map(row => ({ id: row.id!, name: row.name || row.username || '已删除用户', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    groups: groupRows.filter(row => row.id).map(row => ({ id: row.id!, name: row.name || '已删除分组', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    activeKeys: number(keyCount?.value),
    activeUsers: number(userCount?.value),
    activeGroups: number(groupCount?.value),
    healthyChannels
  }
}

export async function listRequestLogs(event: H3Event, query: Record<string, string | undefined>) {
  validateDimensionFilters(query)
  const db = useDatabase(event)
  const page = Math.max(1, Number.parseInt(query.page || '1') || 1)
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(query.pageSize || '50') || 50))
  const conditions = []
  if (query.keyId) conditions.push(eq(requestLogs.keyId, query.keyId))
  if (query.channelId) conditions.push(eq(requestLogs.channelId, query.channelId))
  if (query.resourceType) conditions.push(eq(requestLogs.resourceType, query.resourceType as 'subscription' | 'user_relay' | 'private_pool' | 'unresolved'))
  if (query.resourceId) conditions.push(eq(requestLogs.resourceId, query.resourceId))
  if (query.model) conditions.push(eq(requestLogs.requestedModel, query.model))
  if (query.endpoint) conditions.push(eq(requestLogs.endpoint, query.endpoint))
  if (query.status) conditions.push(eq(requestLogs.status, query.status as 'pending' | 'success' | 'error' | 'stream_aborted'))
  if (query.search) conditions.push(or(ilike(requestLogs.requestId, `%${query.search}%`), ilike(requestLogs.errorMessage, `%${query.search}%`))!)
  const from = dateFilter(query.from, '开始时间')
  const to = dateFilter(query.to, '结束时间')
  if (from && to && from >= to) throw createError({ statusCode: 400, message: '日志时间范围不正确' })
  if (from) conditions.push(gte(requestLogs.createdAt, from))
  if (to) conditions.push(lt(requestLogs.createdAt, to))
  const where = conditions.length ? and(...conditions) : undefined
  const rows = await db.select({ log: requestLogs, keyName: hubKeys.name, channelName: channels.name })
    .from(requestLogs)
    .leftJoin(hubKeys, eq(requestLogs.keyId, hubKeys.id))
    .leftJoin(channels, eq(requestLogs.channelId, channels.id))
    .where(where).orderBy(desc(requestLogs.createdAt)).limit(pageSize).offset((page - 1) * pageSize)
  const [[total], resourceStats, executionStats] = await Promise.all([
    db.select({ value: count() }).from(requestLogs).where(where),
    db.select({ type: requestLogs.resourceType, id: requestLogs.resourceId, name: requestLogs.resourceNameSnapshot, requests: count(), tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)` }).from(requestLogs).where(where).groupBy(requestLogs.resourceType, requestLogs.resourceId, requestLogs.resourceNameSnapshot).orderBy(desc(count())).limit(50),
    db.select({ channelId: requestLogs.channelId, name: requestLogs.executionNameSnapshot, requests: count(), tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)` }).from(requestLogs).where(where).groupBy(requestLogs.channelId, requestLogs.executionNameSnapshot).orderBy(desc(count())).limit(50)
  ])
  const items: RequestLogView[] = rows.map(({ log, keyName, channelName }) => ({
    id: log.id,
    requestId: log.requestId,
    keyId: log.keyId,
    keyName,
    endpoint: log.endpoint,
    requestedModel: log.requestedModel,
    upstreamModel: log.upstreamModel,
    reasoningEffort: log.reasoningEffort,
    channelId: log.channelId,
    channelName,
    resourceType: log.resourceType,
    resourceId: log.resourceId,
    resourceName: log.resourceNameSnapshot || requestResourceFallback(log.resourceType),
    executionName: log.executionNameSnapshot || channelName,
    userRelayGroupId: log.userRelayGroupId,
    status: log.status,
    httpStatus: log.httpStatus,
    totalTokens: log.totalTokens,
    cost: Number(log.cost),
    firstByteMs: log.firstByteMs,
    durationMs: log.durationMs,
    streaming: log.streaming,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt.getTime()
  }))
  return {
    items, page, pageSize, total: number(total?.value),
    resourceStats: resourceStats.map(row => ({ type: row.type, id: row.id, name: row.name || requestResourceFallback(row.type), requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) })),
    executionStats: executionStats.map(row => ({ channelId: row.channelId, name: row.name || '未执行', requests: number(row.requests), tokens: number(row.tokens), cost: number(row.cost) }))
  }
}

export async function requestLogDetail(event: H3Event, id: string) {
  const db = useDatabase(event)
  const [row] = await db.select({ log: requestLogs, keyName: hubKeys.name, channelName: channels.name })
    .from(requestLogs).leftJoin(hubKeys, eq(requestLogs.keyId, hubKeys.id)).leftJoin(channels, eq(requestLogs.channelId, channels.id))
    .where(eq(requestLogs.id, id)).limit(1)
  if (!row) throw createError({ statusCode: 404, message: '请求日志不存在' })
  const attempts = await db.select().from(requestAttempts).where(eq(requestAttempts.requestLogId, id)).orderBy(asc(requestAttempts.attempt))
  const readBody = async (key: string | null) => {
    if (!key || row.log.bodyExpiresAt && row.log.bodyExpiresAt <= new Date()) return null
    try {
      const result = await readEncryptedBody(event, key)
      const textual = /json|text|xml|javascript|event-stream/.test(result.contentType)
      return { contentType: result.contentType, encoding: textual ? 'utf8' : 'base64', content: result.body.toString(textual ? 'utf8' : 'base64') }
    } catch { return null }
  }
  return { ...row.log, keyName: row.keyName, channelName: row.channelName, attempts, requestBody: await readBody(row.log.requestBodyObject), responseBody: await readBody(row.log.responseBodyObject) }
}

export async function hubKeyUsageDetail(event: H3Event, keyId: string) {
  const db = useDatabase(event)
  const timezone = (await getHubSettings(event)).timezone
  const now = new Date()
  const starts = {
    today: startOfZoned(now, 'day', timezone).toISOString(),
    week: startOfZoned(now, 'week', timezone).toISOString(),
    month: startOfZoned(now, 'month', timezone).toISOString()
  }
  const condition = and(eq(usageRollups.keyId, keyId), eq(usageRollups.granularity, 'day'))
  const [usage] = await db.select({
    allRequests: sql<number>`coalesce(sum(${usageRollups.requests}), 0)`,
    allAdmittedRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`,
    allSuccesses: sql<number>`coalesce(sum(${usageRollups.successes}), 0)`,
    allTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`,
    allCost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)`,
    todayRequests: sql<number>`coalesce(sum(${usageRollups.requests}) filter (where ${usageRollups.bucketStart} >= ${starts.today}::timestamptz), 0)`,
    todayAdmittedRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.today}::timestamptz), 0)`,
    todaySuccesses: sql<number>`coalesce(sum(${usageRollups.successes}) filter (where ${usageRollups.bucketStart} >= ${starts.today}::timestamptz), 0)`,
    todayTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.today}::timestamptz), 0)`,
    todayCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.today}::timestamptz), 0)`,
    weekRequests: sql<number>`coalesce(sum(${usageRollups.requests}) filter (where ${usageRollups.bucketStart} >= ${starts.week}::timestamptz), 0)`,
    weekAdmittedRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.week}::timestamptz), 0)`,
    weekSuccesses: sql<number>`coalesce(sum(${usageRollups.successes}) filter (where ${usageRollups.bucketStart} >= ${starts.week}::timestamptz), 0)`,
    weekTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.week}::timestamptz), 0)`,
    weekCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.week}::timestamptz), 0)`,
    monthRequests: sql<number>`coalesce(sum(${usageRollups.requests}) filter (where ${usageRollups.bucketStart} >= ${starts.month}::timestamptz), 0)`,
    monthAdmittedRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.month}::timestamptz), 0)`,
    monthSuccesses: sql<number>`coalesce(sum(${usageRollups.successes}) filter (where ${usageRollups.bucketStart} >= ${starts.month}::timestamptz), 0)`,
    monthTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.month}::timestamptz), 0)`,
    monthCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.month}::timestamptz), 0)`
  }).from(usageRollups).where(condition)
  const period = (id: 'all' | 'today' | 'week' | 'month') => {
    const prefix = id === 'all' ? 'all' : id
    const requests = number(usage?.[`${prefix}Requests`])
    const successes = number(usage?.[`${prefix}Successes`])
    return {
      id,
      requests,
      admittedRequests: number(usage?.[`${prefix}AdmittedRequests`]),
      tokens: number(usage?.[`${prefix}Tokens`]),
      cost: number(usage?.[`${prefix}Cost`]),
      successRate: requests ? successes / requests * 100 : null
    }
  }
  const recent = await listRequestLogs(event, { keyId, page: '1', pageSize: '10' })
  return { periods: [period('all'), period('today'), period('week'), period('month')], recentRequests: recent.items }
}
