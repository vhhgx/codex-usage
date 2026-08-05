import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channels, hubKeys, usageRollups } from '../db/schema'
import { getHubSettings } from './hub-settings'
import { startOfZoned } from '../utils/time-zone'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ROWS = 100000

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export async function buildUsageExport(event: H3Event, query: Record<string, string | undefined>) {
  if (query.keyId && !UUID_PATTERN.test(query.keyId)) throw createError({ statusCode: 400, message: 'Hub Key 筛选值格式不正确' })
  if (query.channelId && !UUID_PATTERN.test(query.channelId)) throw createError({ statusCode: 400, message: '渠道筛选值格式不正确' })
  const settings = await getHubSettings(event)
  const now = new Date()
  const from = query.from ? new Date(query.from) : new Date(now.getTime() - 30 * 86400_000)
  const to = query.to ? new Date(query.to) : now
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw createError({ statusCode: 400, message: '导出时间范围不正确' })
  const rows = await useDatabase(event).select({
    bucketStart: usageRollups.bucketStart,
    keyId: usageRollups.keyId,
    keyName: hubKeys.name,
    channelId: usageRollups.channelId,
    channelName: channels.name,
    model: usageRollups.model,
    endpoint: usageRollups.endpoint,
    status: usageRollups.status,
    requests: usageRollups.requests,
    admittedRequests: usageRollups.admittedRequests,
    inputTokens: usageRollups.inputTokens,
    outputTokens: usageRollups.outputTokens,
    totalTokens: usageRollups.totalTokens,
    cost: usageRollups.cost,
    durationMs: usageRollups.durationMs,
    failovers: usageRollups.failovers
  }).from(usageRollups)
    .leftJoin(hubKeys, eq(usageRollups.keyId, hubKeys.id))
    .leftJoin(channels, eq(usageRollups.channelId, channels.id))
    .where(and(
      eq(usageRollups.granularity, 'day'),
      gte(usageRollups.bucketStart, startOfZoned(from, 'day', settings.timezone)),
      lte(usageRollups.bucketStart, startOfZoned(to, 'day', settings.timezone)),
      query.keyId ? eq(usageRollups.keyId, query.keyId) : undefined,
      query.channelId ? eq(usageRollups.channelId, query.channelId) : undefined,
      query.model ? eq(usageRollups.model, query.model.slice(0, 200)) : undefined,
      query.endpoint ? eq(usageRollups.endpoint, query.endpoint.slice(0, 100)) : undefined,
      query.status ? eq(usageRollups.status, query.status.slice(0, 100)) : undefined
    )).orderBy(asc(usageRollups.bucketStart)).limit(MAX_ROWS + 1)
  if (rows.length > MAX_ROWS) throw createError({ statusCode: 413, message: '导出结果超过 100000 行，请缩小时间或筛选范围' })
  const records = rows.map(row => ({
    date: row.bucketStart.toISOString(), keyId: row.keyId, keyName: row.keyName || 'deleted',
    channelId: row.channelId, channelName: row.channelName || 'deleted', model: row.model,
    endpoint: row.endpoint, status: row.status, requests: row.requests, admittedRequests: row.admittedRequests,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens,
    costUsd: Number(row.cost), durationMs: row.durationMs, failovers: row.failovers
  }))
  if (query.format === 'json') return { format: 'json' as const, records, from: from.getTime(), to: to.getTime() }
  const columns = ['date','keyId','keyName','channelId','channelName','model','endpoint','status','requests','admittedRequests','inputTokens','outputTokens','totalTokens','costUsd','durationMs','failovers'] as const
  const csv = `\uFEFF${columns.join(',')}\n${records.map(record => columns.map(column => csvCell(record[column])).join(',')).join('\n')}\n`
  return { format: 'csv' as const, csv, count: records.length, from: from.getTime(), to: to.getTime() }
}
