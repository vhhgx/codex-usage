import { eq, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channels, hubKeys, usageRollups } from '../db/schema'

const mergeColumns = sql`
  requests = usage_rollups.requests + excluded.requests,
  admitted_requests = usage_rollups.admitted_requests + excluded.admitted_requests,
  successes = usage_rollups.successes + excluded.successes,
  failures = usage_rollups.failures + excluded.failures,
  input_tokens = usage_rollups.input_tokens + excluded.input_tokens,
  output_tokens = usage_rollups.output_tokens + excluded.output_tokens,
  total_tokens = usage_rollups.total_tokens + excluded.total_tokens,
  cost = usage_rollups.cost + excluded.cost,
  duration_ms = usage_rollups.duration_ms + excluded.duration_ms,
  latency_count = usage_rollups.latency_count + excluded.latency_count,
  latency_le_100 = usage_rollups.latency_le_100 + excluded.latency_le_100,
  latency_le_250 = usage_rollups.latency_le_250 + excluded.latency_le_250,
  latency_le_500 = usage_rollups.latency_le_500 + excluded.latency_le_500,
  latency_le_1000 = usage_rollups.latency_le_1000 + excluded.latency_le_1000,
  latency_le_2500 = usage_rollups.latency_le_2500 + excluded.latency_le_2500,
  latency_le_5000 = usage_rollups.latency_le_5000 + excluded.latency_le_5000,
  latency_le_10000 = usage_rollups.latency_le_10000 + excluded.latency_le_10000,
  failovers = usage_rollups.failovers + excluded.failovers,
  updated_at = now()
`

const rollupColumns = sql`
  bucket_start, granularity, key_id, user_id, group_id, model, endpoint, status, channel_id,
  requests, admitted_requests, successes, failures, input_tokens, output_tokens, total_tokens,
  cost, duration_ms, latency_count, latency_le_100, latency_le_250, latency_le_500,
  latency_le_1000, latency_le_2500, latency_le_5000, latency_le_10000, failovers,
  created_at, updated_at
`

const conflictDimensions = sql`
  (bucket_start, granularity, key_id, user_id, group_id, model, endpoint, status, channel_id)
`

export async function deleteHubKeyPreservingRollups(event: H3Event, id: string) {
  return useDatabase(event).transaction(async (tx) => {
    const [existing] = await tx.select({ id: hubKeys.id }).from(hubKeys).where(eq(hubKeys.id, id)).limit(1)
    if (!existing) return false
    await tx.execute(sql`
      insert into usage_rollups (${rollupColumns})
      select bucket_start, granularity, null, user_id, group_id, model, endpoint, status, channel_id,
        requests, admitted_requests, successes, failures, input_tokens, output_tokens, total_tokens,
        cost, duration_ms, latency_count, latency_le_100, latency_le_250, latency_le_500,
        latency_le_1000, latency_le_2500, latency_le_5000, latency_le_10000, failovers,
        created_at, now()
      from usage_rollups where key_id = ${id}
      on conflict ${conflictDimensions} do update set ${mergeColumns}
    `)
    await tx.delete(usageRollups).where(eq(usageRollups.keyId, id))
    await tx.delete(hubKeys).where(eq(hubKeys.id, id))
    return true
  })
}

export async function deleteChannelPreservingRollups(event: H3Event, id: string) {
  return useDatabase(event).transaction(async (tx) => {
    const [existing] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, id)).limit(1)
    if (!existing) return false
    await tx.execute(sql`
      insert into usage_rollups (${rollupColumns})
      select bucket_start, granularity, key_id, user_id, group_id, model, endpoint, status, null,
        requests, admitted_requests, successes, failures, input_tokens, output_tokens, total_tokens,
        cost, duration_ms, latency_count, latency_le_100, latency_le_250, latency_le_500,
        latency_le_1000, latency_le_2500, latency_le_5000, latency_le_10000, failovers,
        created_at, now()
      from usage_rollups where channel_id = ${id}
      on conflict ${conflictDimensions} do update set ${mergeColumns}
    `)
    await tx.delete(usageRollups).where(eq(usageRollups.channelId, id))
    await tx.delete(channels).where(eq(channels.id, id))
    return true
  })
}
