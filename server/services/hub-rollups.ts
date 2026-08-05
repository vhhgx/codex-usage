import { sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { usageRollups } from '../db/schema'
import { getHubSettings } from './hub-settings'
import { startOfZoned } from '../utils/time-zone'

export async function recordUsageRollups(event: H3Event | undefined, value: {
  keyId: string | null
  userId: string | null
  groupId: string | null
  channelId: string | null
  model: string | null
  endpoint: string
  status: 'success' | 'error' | 'stream_aborted'
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
  durationMs: number
  failovers: number
  admitted?: boolean
}) {
  const db = useDatabase(event)
  const timezone = (await getHubSettings(event)).timezone
  for (const granularity of ['hour', 'day'] as const) {
    await db.insert(usageRollups).values({
      bucketStart: startOfZoned(new Date(), granularity, timezone),
      granularity,
      keyId: value.keyId,
      userId: value.userId,
      groupId: value.groupId,
      channelId: value.channelId,
      model: value.model,
      endpoint: value.endpoint,
      status: value.status,
      requests: 1,
      admittedRequests: value.admitted === false ? 0 : 1,
      successes: value.status === 'success' ? 1 : 0,
      failures: value.status === 'success' ? 0 : 1,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      totalTokens: value.totalTokens,
      cost: String(value.cost),
      durationMs: value.durationMs,
      latencyCount: 1,
      latencyLe100: value.durationMs <= 100 ? 1 : 0,
      latencyLe250: value.durationMs <= 250 ? 1 : 0,
      latencyLe500: value.durationMs <= 500 ? 1 : 0,
      latencyLe1000: value.durationMs <= 1000 ? 1 : 0,
      latencyLe2500: value.durationMs <= 2500 ? 1 : 0,
      latencyLe5000: value.durationMs <= 5000 ? 1 : 0,
      latencyLe10000: value.durationMs <= 10000 ? 1 : 0,
      failovers: value.failovers
    }).onConflictDoUpdate({
      target: [usageRollups.bucketStart, usageRollups.granularity, usageRollups.keyId, usageRollups.userId, usageRollups.groupId, usageRollups.model, usageRollups.endpoint, usageRollups.status, usageRollups.channelId],
      set: {
        requests: sql`${usageRollups.requests} + 1`,
        admittedRequests: sql`${usageRollups.admittedRequests} + ${value.admitted === false ? 0 : 1}`,
        successes: sql`${usageRollups.successes} + ${value.status === 'success' ? 1 : 0}`,
        failures: sql`${usageRollups.failures} + ${value.status === 'success' ? 0 : 1}`,
        inputTokens: sql`${usageRollups.inputTokens} + ${value.inputTokens}`,
        outputTokens: sql`${usageRollups.outputTokens} + ${value.outputTokens}`,
        totalTokens: sql`${usageRollups.totalTokens} + ${value.totalTokens}`,
        cost: sql`${usageRollups.cost} + ${value.cost}`,
        durationMs: sql`${usageRollups.durationMs} + ${value.durationMs}`,
        latencyCount: sql`${usageRollups.latencyCount} + 1`,
        latencyLe100: sql`${usageRollups.latencyLe100} + ${value.durationMs <= 100 ? 1 : 0}`,
        latencyLe250: sql`${usageRollups.latencyLe250} + ${value.durationMs <= 250 ? 1 : 0}`,
        latencyLe500: sql`${usageRollups.latencyLe500} + ${value.durationMs <= 500 ? 1 : 0}`,
        latencyLe1000: sql`${usageRollups.latencyLe1000} + ${value.durationMs <= 1000 ? 1 : 0}`,
        latencyLe2500: sql`${usageRollups.latencyLe2500} + ${value.durationMs <= 2500 ? 1 : 0}`,
        latencyLe5000: sql`${usageRollups.latencyLe5000} + ${value.durationMs <= 5000 ? 1 : 0}`,
        latencyLe10000: sql`${usageRollups.latencyLe10000} + ${value.durationMs <= 10000 ? 1 : 0}`,
        failovers: sql`${usageRollups.failovers} + ${value.failovers}`,
        updatedAt: new Date()
      }
    })
  }
}
