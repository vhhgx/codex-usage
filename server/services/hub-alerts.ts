import { createHmac } from 'node:crypto'
import type { H3Event } from 'h3'
import { useRedis } from '../utils/redis'
import { collectHubObservation } from './hub-observability'
import { and, eq, gt, gte, isNotNull, lt, or, sql } from 'drizzle-orm'
import { useDatabase } from '../db'
import { groups, hubKeys, usageRollups } from '../db/schema'
import { getHubSettings } from './hub-settings'
import { startOfZoned } from '../utils/time-zone'

interface AlertCondition {
  id: string
  title: string
  message: string
  severity: 'warning' | 'critical'
  value: number | string
  threshold: number | string
}

const STATE_KEY = 'hub:alerts:active'

function numberConfig(value: unknown, fallback: number, min = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

function alertConfig(event?: H3Event) {
  const config = useRuntimeConfig(event)
  return {
    webhookUrl: String(config.alertWebhookUrl || '').trim(),
    webhookSecret: String(config.alertWebhookSecret || ''),
    failureRate: numberConfig(config.alertFailureRate, 0.2),
    minimumRequests: numberConfig(config.alertMinimumRequests, 20, 1),
    streamAbortRate: numberConfig(config.alertStreamAbortRate, 0.1),
    firstByteMs: numberConfig(config.alertFirstByteMs, 5000, 1),
    pendingRequests: numberConfig(config.alertPendingRequests, 100, 1),
    memoryRssBytes: numberConfig(config.alertMemoryRssBytes, 768 * 1024 * 1024, 1),
    cooldownSeconds: numberConfig(config.alertCooldownSeconds, 1800, 60)
  }
}

async function postWebhook(event: H3Event | undefined, payload: Record<string, unknown>) {
  const config = alertConfig(event)
  if (!config.webhookUrl) return false
  const url = new URL(config.webhookUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Alert webhook URL must use HTTP or HTTPS')
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Zephyr-Hub-Alerts/1.0' }
  if (config.webhookSecret) headers['x-zephyr-signature'] = `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}`)
  return true
}

function conditionsFrom(snapshot: Awaited<ReturnType<typeof collectHubObservation>>, event?: H3Event) {
  const config = alertConfig(event)
  const conditions: AlertCondition[] = []
  if (snapshot.recent.requests >= config.minimumRequests && snapshot.recent.failureRate >= config.failureRate) {
    conditions.push({ id: 'failure-rate', title: 'Hub failure rate is high', message: `Five-minute failure rate is ${(snapshot.recent.failureRate * 100).toFixed(1)}%.`, severity: 'critical', value: snapshot.recent.failureRate, threshold: config.failureRate })
  }
  if (snapshot.recent.streaming >= 5 && snapshot.recent.streamAbortRate >= config.streamAbortRate) {
    conditions.push({ id: 'stream-abort-rate', title: 'SSE interruption rate is high', message: `Five-minute stream interruption rate is ${(snapshot.recent.streamAbortRate * 100).toFixed(1)}%.`, severity: 'critical', value: snapshot.recent.streamAbortRate, threshold: config.streamAbortRate })
  }
  if (snapshot.recent.p95FirstByteMs !== null && snapshot.recent.p95FirstByteMs >= config.firstByteMs) {
    conditions.push({ id: 'first-byte-p95', title: 'First-byte latency is high', message: `Five-minute P95 first body byte is ${Math.round(snapshot.recent.p95FirstByteMs)} ms.`, severity: 'warning', value: snapshot.recent.p95FirstByteMs, threshold: config.firstByteMs })
  }
  if (snapshot.recent.pending >= config.pendingRequests) {
    conditions.push({ id: 'pending-requests', title: 'Pending request count is high', message: `${snapshot.recent.pending} requests remain pending.`, severity: 'critical', value: snapshot.recent.pending, threshold: config.pendingRequests })
  }
  if (process.env.NODE_ENV === 'production' && snapshot.process.rssBytes >= config.memoryRssBytes) {
    const memoryMiB = Math.round(snapshot.process.rssBytes / 1024 / 1024)
    const thresholdMiB = Math.round(config.memoryRssBytes / 1024 / 1024)
    const action = '请滚动重启 Hub 进程释放内存；若数值持续回升，应检查并发请求和内存泄漏。'
    conditions.push({ id: 'process-memory', title: 'Hub 进程内存过高', message: `常驻内存 ${memoryMiB} MiB，告警阈值 ${thresholdMiB} MiB。${action}`, severity: 'critical', value: snapshot.process.rssBytes, threshold: config.memoryRssBytes })
  }
  for (const channel of snapshot.channels.filter(item => item.enabled && (!item.healthy || item.circuit !== 'closed'))) {
    conditions.push({
      id: `channel:${channel.id}`,
      title: `Channel ${channel.name} is unavailable`,
      message: channel.healthy ? `Circuit state is ${channel.circuit}.` : 'The latest channel health check failed.',
      severity: 'critical',
      value: channel.healthy ? channel.circuit : 'unhealthy',
      threshold: 'healthy/closed'
    })
  }
  const endpointGroups = new Map<string, { channelId: string; channelName: string; endpoint: string; requests: number; failures: number }>()
  for (const row of snapshot.endpoints) {
    if (!row.channelId) continue
    const id = `${row.channelId}:${row.endpoint}`
    const group = endpointGroups.get(id) || { channelId: row.channelId, channelName: row.channelName || row.channelId, endpoint: row.endpoint, requests: 0, failures: 0 }
    group.requests += row.requests
    if (row.status === 'error' || row.status === 'stream_aborted') group.failures += row.requests
    endpointGroups.set(id, group)
  }
  for (const group of endpointGroups.values()) {
    const failureRate = group.requests ? group.failures / group.requests : 0
    if (group.requests < config.minimumRequests || failureRate < config.failureRate) continue
    conditions.push({
      id: `channel-endpoint:${group.channelId}:${group.endpoint}`,
      title: `${group.channelName} endpoint is failing`,
      message: `${group.endpoint} five-minute failure rate is ${(failureRate * 100).toFixed(1)}%.`,
      severity: 'critical',
      value: failureRate,
      threshold: config.failureRate
    })
  }
  return conditions
}

async function accessConditions(event?: H3Event): Promise<AlertCondition[]> {
  const db = useDatabase(event)
  const now = new Date()
  const soon = new Date(now.getTime() + 7 * 86400_000)
  const settings = await getHubSettings(event)
  const dayStart = startOfZoned(now, 'day', settings.timezone)
  const [expiring, keyUsage, groupUsage] = await Promise.all([
    db.select({ id: hubKeys.id, name: hubKeys.name, expiresAt: hubKeys.expiresAt }).from(hubKeys).where(and(eq(hubKeys.status, 'active'), isNotNull(hubKeys.expiresAt), gt(hubKeys.expiresAt, now), lt(hubKeys.expiresAt, soon))),
    db.select({ id: hubKeys.id, name: hubKeys.name, requestLimit: hubKeys.dailyRequestLimit, tokenLimit: hubKeys.dailyTokenLimit, costLimit: hubKeys.dailyCostLimit, requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`, tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)` }).from(hubKeys).leftJoin(usageRollups, and(eq(usageRollups.keyId, hubKeys.id), eq(usageRollups.granularity, 'day'), gte(usageRollups.bucketStart, dayStart))).where(eq(hubKeys.status, 'active')).groupBy(hubKeys.id, hubKeys.name, hubKeys.dailyRequestLimit, hubKeys.dailyTokenLimit, hubKeys.dailyCostLimit),
    db.select({ id: groups.id, name: groups.name, requestLimit: groups.dailyRequestLimit, tokenLimit: groups.dailyTokenLimit, costLimit: groups.dailyCostLimit, requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`, tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)` }).from(groups).leftJoin(usageRollups, and(eq(usageRollups.groupId, groups.id), eq(usageRollups.granularity, 'day'), gte(usageRollups.bucketStart, dayStart))).where(eq(groups.status, 'active')).groupBy(groups.id, groups.name, groups.dailyRequestLimit, groups.dailyTokenLimit, groups.dailyCostLimit)
  ])
  const conditions: AlertCondition[] = expiring.map(key => ({ id: `key-expiry:${key.id}`, title: `Key ${key.name} 即将到期`, message: `将在 ${key.expiresAt?.toLocaleString('zh-CN')} 到期。`, severity: 'warning', value: key.expiresAt?.getTime() || 0, threshold: soon.getTime() }))
  const quotaAlerts = (kind: 'key' | 'group', rows: typeof keyUsage) => {
    for (const row of rows) {
      const metrics = [
        ['请求', Number(row.requests), row.requestLimit],
        ['Token', Number(row.tokens), row.tokenLimit],
        ['成本', Number(row.cost), row.costLimit === null ? null : Number(row.costLimit)]
      ] as const
      for (const [label, used, limit] of metrics) {
        if (limit === null || Number(limit) <= 0 || used / Number(limit) < 0.9) continue
        conditions.push({ id: `${kind}-quota:${row.id}:${label}`, title: `${kind === 'key' ? 'Key' : '分组'} ${row.name} 日额度即将耗尽`, message: `${label}已使用 ${used} / ${limit}。`, severity: used >= Number(limit) ? 'critical' : 'warning', value: used, threshold: Number(limit) })
      }
    }
  }
  quotaAlerts('key', keyUsage)
  quotaAlerts('group', groupUsage as typeof keyUsage)
  return conditions
}

export async function evaluateHubAlerts(event?: H3Event) {
  const config = alertConfig(event)
  const snapshot = await collectHubObservation(event)
  const conditions = [...conditionsFrom(snapshot, event), ...await accessConditions(event)]
  if (!config.webhookUrl) return { configured: false, active: conditions, sent: 0, recovered: 0, generatedAt: snapshot.generatedAt }
  const redis = useRedis(event)
  const stored = await redis.hgetall(STATE_KEY)
  const activeIds = new Set(conditions.map(condition => condition.id))
  let sent = 0
  let recovered = 0
  for (const condition of conditions) {
    const previous = stored[condition.id] ? JSON.parse(stored[condition.id]!) as { lastSentAt: number } : null
    if (previous && snapshot.generatedAt - previous.lastSentAt < config.cooldownSeconds * 1000) continue
    if (await postWebhook(event, { source: 'zephyr-hub', status: 'firing', generatedAt: snapshot.generatedAt, condition })) {
      await redis.hset(STATE_KEY, condition.id, JSON.stringify({ ...condition, lastSentAt: snapshot.generatedAt }))
      sent += 1
    }
  }
  for (const [id, raw] of Object.entries(stored)) {
    if (activeIds.has(id)) continue
    const condition = JSON.parse(raw) as AlertCondition
    if (await postWebhook(event, { source: 'zephyr-hub', status: 'resolved', generatedAt: snapshot.generatedAt, condition })) {
      await redis.hdel(STATE_KEY, id)
      recovered += 1
    }
  }
  return { configured: true, active: conditions, sent, recovered, generatedAt: snapshot.generatedAt }
}

export async function getHubAlertStatus(event: H3Event) {
  const snapshot = await collectHubObservation(event)
  const conditions = [...conditionsFrom(snapshot, event), ...await accessConditions(event)]
  const stored = await useRedis(event).hgetall(STATE_KEY)
  return {
    configured: Boolean(alertConfig(event).webhookUrl),
    active: conditions,
    tracked: Object.keys(stored),
    generatedAt: snapshot.generatedAt
  }
}

export async function testAlertWebhook(event: H3Event) {
  const configured = Boolean(alertConfig(event).webhookUrl)
  if (!configured) throw createError({ statusCode: 400, message: '未配置告警 Webhook URL' })
  await postWebhook(event, {
    source: 'zephyr-hub',
    status: 'test',
    generatedAt: Date.now(),
    condition: { id: 'webhook-test', title: 'Zephyr Hub alert test', message: 'Webhook delivery is configured correctly.', severity: 'warning' }
  })
  return { delivered: true }
}
