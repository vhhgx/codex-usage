import { and, count, eq, gte, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channels, requestLogs, usageRollups } from '../db/schema'
import { channelCircuitState } from './hub-routing'

const WINDOW_MS = 5 * 60_000

function numeric(value: unknown) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

export async function collectHubObservation(event?: H3Event) {
  const db = useDatabase(event)
  const since = new Date(Date.now() - WINDOW_MS)
  const [[recent], channelRows, endpointRows, counterRows, [pending]] = await Promise.all([
    db.select({
      requests: count(),
      failures: sql<number>`count(*) filter (where ${requestLogs.status} in ('error', 'stream_aborted'))`,
      streaming: sql<number>`count(*) filter (where ${requestLogs.streaming} = true)`,
      streamAborts: sql<number>`count(*) filter (where ${requestLogs.status} = 'stream_aborted')`,
      p95FirstByte: sql<number>`percentile_cont(0.95) within group (order by ${requestLogs.firstByteMs}) filter (where ${requestLogs.firstByteMs} is not null)`,
      p95Duration: sql<number>`percentile_cont(0.95) within group (order by ${requestLogs.durationMs}) filter (where ${requestLogs.durationMs} is not null)`
    }).from(requestLogs).where(gte(requestLogs.createdAt, since)),
    db.select().from(channels),
    db.select({
      endpoint: requestLogs.endpoint,
      status: requestLogs.status,
      channelId: requestLogs.channelId,
      channelName: channels.name,
      requests: count()
    }).from(requestLogs).leftJoin(channels, eq(requestLogs.channelId, channels.id)).where(gte(requestLogs.createdAt, since))
      .groupBy(requestLogs.endpoint, requestLogs.status, requestLogs.channelId, channels.name),
    db.select({
      endpoint: usageRollups.endpoint,
      status: usageRollups.status,
      requests: sql<number>`coalesce(sum(${usageRollups.requests}), 0)`,
      tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`,
      cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)`
    }).from(usageRollups).where(eq(usageRollups.granularity, 'day')).groupBy(usageRollups.endpoint, usageRollups.status),
    db.select({ value: count() }).from(requestLogs).where(and(eq(requestLogs.status, 'pending'), gte(requestLogs.createdAt, new Date(Date.now() - 24 * 3600_000))))
  ])
  const channelStates = await Promise.all(channelRows.map(async channel => ({
    id: channel.id,
    name: channel.name,
    enabled: channel.enabled,
    healthy: channel.healthStatus === 'healthy',
    circuit: await channelCircuitState(event, channel.id)
  })))
  const requests = numeric(recent?.requests)
  const failures = numeric(recent?.failures)
  const streaming = numeric(recent?.streaming)
  const streamAborts = numeric(recent?.streamAborts)
  const memory = process.memoryUsage()
  return {
    generatedAt: Date.now(),
    windowSeconds: WINDOW_MS / 1000,
    recent: {
      requests,
      failures,
      failureRate: requests ? failures / requests : 0,
      streaming,
      streamAborts,
      streamAbortRate: streaming ? streamAborts / streaming : 0,
      p95FirstByteMs: numeric(recent?.p95FirstByte) || null,
      p95DurationMs: numeric(recent?.p95Duration) || null,
      pending: numeric(pending?.value)
    },
    endpoints: endpointRows.map(row => ({ endpoint: row.endpoint, status: row.status, channelId: row.channelId, channelName: row.channelName, requests: numeric(row.requests) })),
    counters: counterRows.map(row => ({ endpoint: row.endpoint, status: row.status, requests: numeric(row.requests), tokens: numeric(row.tokens), cost: numeric(row.cost) })),
    channels: channelStates,
    process: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, uptimeSeconds: process.uptime() }
  }
}

function escapeLabel(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function metric(lines: string[], name: string, help: string, type: 'counter' | 'gauge', values: Array<{ labels?: Record<string, string>; value: number }>) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
  for (const item of values) {
    const labels = item.labels && Object.keys(item.labels).length
      ? `{${Object.entries(item.labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`
      : ''
    lines.push(`${name}${labels} ${item.value}`)
  }
}

export async function renderPrometheusMetrics(event: H3Event) {
  const snapshot = await collectHubObservation(event)
  const lines: string[] = []
  metric(lines, 'zephyr_hub_requests_total', 'Completed and rejected Hub requests.', 'counter', snapshot.counters.map(row => ({ labels: { endpoint: row.endpoint, status: row.status }, value: row.requests })))
  metric(lines, 'zephyr_hub_tokens_total', 'Tokens processed by the Hub.', 'counter', snapshot.counters.map(row => ({ labels: { endpoint: row.endpoint, status: row.status }, value: row.tokens })))
  metric(lines, 'zephyr_hub_cost_usd_total', 'Calculated Hub cost in USD.', 'counter', snapshot.counters.map(row => ({ labels: { endpoint: row.endpoint, status: row.status }, value: row.cost })))
  metric(lines, 'zephyr_hub_recent_requests', 'Requests observed in the rolling five-minute window.', 'gauge', [{ value: snapshot.recent.requests }])
  metric(lines, 'zephyr_hub_channel_endpoint_recent_requests', 'Requests by channel, endpoint, and status in the rolling five-minute window.', 'gauge', snapshot.endpoints.map(row => ({ labels: { channel_id: row.channelId || 'none', channel: row.channelName || 'none', endpoint: row.endpoint, status: row.status }, value: row.requests })))
  metric(lines, 'zephyr_hub_recent_failure_ratio', 'Failure ratio in the rolling five-minute window.', 'gauge', [{ value: snapshot.recent.failureRate }])
  metric(lines, 'zephyr_hub_recent_stream_abort_ratio', 'SSE abort ratio in the rolling five-minute window.', 'gauge', [{ value: snapshot.recent.streamAbortRate }])
  metric(lines, 'zephyr_hub_recent_first_byte_p95_milliseconds', 'P95 first response body byte latency.', 'gauge', [{ value: snapshot.recent.p95FirstByteMs || 0 }])
  metric(lines, 'zephyr_hub_recent_duration_p95_milliseconds', 'P95 total request duration.', 'gauge', [{ value: snapshot.recent.p95DurationMs || 0 }])
  metric(lines, 'zephyr_hub_pending_requests', 'Requests currently recorded as pending.', 'gauge', [{ value: snapshot.recent.pending }])
  metric(lines, 'zephyr_hub_channel_healthy', 'Whether an enabled channel is healthy.', 'gauge', snapshot.channels.map(channel => ({ labels: { channel_id: channel.id, channel: channel.name }, value: channel.enabled && channel.healthy ? 1 : 0 })))
  metric(lines, 'zephyr_hub_channel_circuit_open', 'Whether a channel circuit is open or half-open.', 'gauge', snapshot.channels.map(channel => ({ labels: { channel_id: channel.id, channel: channel.name, state: channel.circuit }, value: channel.circuit === 'closed' ? 0 : 1 })))
  metric(lines, 'zephyr_hub_process_resident_memory_bytes', 'Resident memory used by the Hub process.', 'gauge', [{ value: snapshot.process.rssBytes }])
  metric(lines, 'zephyr_hub_process_heap_used_bytes', 'JavaScript heap memory used by the Hub process.', 'gauge', [{ value: snapshot.process.heapUsedBytes }])
  metric(lines, 'zephyr_hub_process_uptime_seconds', 'Hub process uptime.', 'gauge', [{ value: snapshot.process.uptimeSeconds }])
  return `${lines.join('\n')}\n`
}
