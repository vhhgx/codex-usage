import { and, asc, count, gte, inArray, isNotNull, lt, max, ne, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { HubKeyStatus, KeyActivityResponse } from '#shared/types/hub'
import { useDatabase } from '../db'
import { requestLogs } from '../db/schema'
import { zonedDateKey, zonedDateStart } from '../utils/time-zone'
import { listHubKeys } from './hub-admin'
import { getHubSettings } from './hub-settings'

interface ActivityKey {
  id: string
  name: string
  maskedKey: string
  status: HubKeyStatus
}

export interface ActivityRow {
  keyId: string
  slot: number
  requests: number
  successes: number
  failures: number
  pending: number
  tokens: number
  cost: number
  lastSeenAt: number
}

export const KEY_ACTIVITY_STATUSES = ['success', 'error', 'stream_aborted', 'pending'] as const
export const KEY_ACTIVITY_EXCLUDED_ENDPOINT = '/v1/models'

export function isKeyActivityRequest(value: { keyId: string | null; endpoint: string; status: string }) {
  return Boolean(value.keyId) && value.endpoint !== KEY_ACTIVITY_EXCLUDED_ENDPOINT && (KEY_ACTIVITY_STATUSES as readonly string[]).includes(value.status)
}

function numeric(value: unknown) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function nextDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

export function keyActivityRange(dateKey: string, timezone: string) {
  const from = zonedDateStart(dateKey, timezone)
  if (zonedDateKey(from, timezone) !== dateKey) throw new Error('Invalid date key')
  return { from, to: zonedDateStart(nextDateKey(dateKey), timezone) }
}

export function buildKeyActivityResponse(input: {
  timezone: string
  dateKey: string
  from: number
  to: number
  generatedAt: number
  keys: ActivityKey[]
  rows: ActivityRow[]
}): KeyActivityResponse {
  const recentThreshold = input.generatedAt - 5 * 60_000
  const bucketRanges: Array<{ timestamp: number; endTimestamp: number; label: string }> = []
  const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timezone,
    hour: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset'
  })
  for (let timestamp = input.from; timestamp < input.to; timestamp += 3600_000) {
    bucketRanges.push({
      timestamp,
      endTimestamp: Math.min(timestamp + 3600_000, input.to),
      label: hourFormatter.format(timestamp).replace(':00', '')
    })
  }
  const rowsByKey = new Map<string, ActivityRow[]>()
  for (const row of input.rows) rowsByKey.set(row.keyId, [...(rowsByKey.get(row.keyId) || []), row])

  const keys = input.keys.map(key => {
    const rows = rowsByKey.get(key.id) || []
    const bySlot = new Map(rows.map(row => [row.slot, row]))
    const buckets = bucketRanges.map((bucket, slot) => {
      const row = bySlot.get(slot)
      return {
        ...bucket,
        requests: numeric(row?.requests),
        tokens: numeric(row?.tokens),
        cost: numeric(row?.cost),
        failures: numeric(row?.failures)
      }
    })
    const requests = rows.reduce((sum, row) => sum + numeric(row.requests), 0)
    const lastSeenAt = rows.length ? Math.max(...rows.map(row => numeric(row.lastSeenAt))) : null
    return {
      ...key,
      requests,
      successes: rows.reduce((sum, row) => sum + numeric(row.successes), 0),
      failures: rows.reduce((sum, row) => sum + numeric(row.failures), 0),
      pending: rows.reduce((sum, row) => sum + numeric(row.pending), 0),
      tokens: rows.reduce((sum, row) => sum + numeric(row.tokens), 0),
      cost: rows.reduce((sum, row) => sum + numeric(row.cost), 0),
      lastSeenAt,
      recentlyActive: lastSeenAt !== null && lastSeenAt >= recentThreshold && lastSeenAt <= input.generatedAt,
      buckets
    }
  })
  return {
    timezone: input.timezone,
    from: input.from,
    to: input.to,
    generatedAt: input.generatedAt,
    activeCount: keys.filter(key => key.requests > 0).length,
    recentlyActiveCount: keys.filter(key => key.recentlyActive).length,
    buckets: bucketRanges,
    keys
  }
}

export async function getKeyActivity(event: H3Event, requestedDate?: string): Promise<KeyActivityResponse> {
  const settings = await getHubSettings(event)
  const generatedAt = Date.now()
  const dateKey = requestedDate || zonedDateKey(new Date(generatedAt), settings.timezone)
  let range: ReturnType<typeof keyActivityRange>
  try { range = keyActivityRange(dateKey, settings.timezone) }
  catch { throw createError({ statusCode: 400, message: '日期格式不正确' }) }

  const db = useDatabase(event)
  const keys = await listHubKeys(event)
  const slot = sql<number>`floor(extract(epoch from (${requestLogs.createdAt} - ${range.from.toISOString()}::timestamptz)) / 3600)`
  const rows = await db.select({
    keyId: requestLogs.keyId,
    slot,
    requests: count(),
    successes: sql<number>`count(*) filter (where ${requestLogs.status} = 'success')`,
    failures: sql<number>`count(*) filter (where ${requestLogs.status} in ('error', 'stream_aborted'))`,
    pending: sql<number>`count(*) filter (where ${requestLogs.status} = 'pending')`,
    tokens: sql<number>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
    cost: sql<string>`coalesce(sum(${requestLogs.cost}), 0)`,
    lastSeenAt: max(requestLogs.createdAt)
  }).from(requestLogs).where(and(
    gte(requestLogs.createdAt, range.from),
    lt(requestLogs.createdAt, range.to),
    isNotNull(requestLogs.keyId),
    ne(requestLogs.endpoint, KEY_ACTIVITY_EXCLUDED_ENDPOINT),
    inArray(requestLogs.status, [...KEY_ACTIVITY_STATUSES])
  )).groupBy(requestLogs.keyId, sql`2`).orderBy(asc(sql`2`))

  return buildKeyActivityResponse({
    timezone: settings.timezone,
    dateKey,
    from: range.from.getTime(),
    to: range.to.getTime(),
    generatedAt,
    keys: keys.map(key => ({ id: key.id, name: key.name, maskedKey: key.maskedKey, status: key.status })),
    rows: rows.map(row => ({
      keyId: row.keyId!, slot: numeric(row.slot), requests: numeric(row.requests),
      successes: numeric(row.successes), failures: numeric(row.failures), pending: numeric(row.pending),
      tokens: numeric(row.tokens), cost: numeric(row.cost), lastSeenAt: row.lastSeenAt!.getTime()
    }))
  })
}
