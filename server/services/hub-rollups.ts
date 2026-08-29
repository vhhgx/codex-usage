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
  protocolBindingId?: string | null
  protocol?: 'anthropic_messages' | 'openai_responses' | 'openai_chat' | null
  model: string | null
  endpoint: string
  status: 'success' | 'error' | 'stream_aborted'
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  cacheCreationTokens?: number
  affinityReused?: boolean
  affinityEligible?: boolean
  totalTokens: number
  cost: number
  durationMs: number
  failovers: number
  admitted?: boolean
  supplySource?: 'platform' | 'private_pool' | 'user_relay'
  poolGroupId?: string | null
  subscriptionId?: string | null
  planVersionId?: string | null
  billableTokens?: number
  billedAmount?: number
  pricingSnapshot?: Record<string, unknown>
}) {
  const db = useDatabase(event)
  const timezone = (await getHubSettings(event)).timezone
  const context = event?.context as Record<string, unknown> | undefined
  const supplySource = value.supplySource || (context?.hubSupplySource as 'platform' | 'private_pool' | 'user_relay' | undefined) || 'platform'
  const poolGroupId = value.poolGroupId || (typeof context?.hubPoolGroupId === 'string' ? context.hubPoolGroupId : null)
  const subscriptionId = value.subscriptionId || (typeof context?.hubSubscriptionId === 'string' ? context.hubSubscriptionId : null)
  const planVersionId = value.planVersionId || (typeof context?.hubPlanVersionId === 'string' ? context.hubPlanVersionId : null)
  const observedAt = new Date()
  await db.transaction(async (tx) => {
    for (const granularity of ['hour', 'day'] as const) {
      await tx.insert(usageRollups).values({
      bucketStart: startOfZoned(observedAt, granularity, timezone),
      granularity,
      keyId: value.keyId,
      userId: value.userId,
      groupId: value.groupId,
      channelId: value.channelId,
      protocolBindingId: value.protocolBindingId || null,
      protocol: value.protocol || null,
      supplySource,
      poolGroupId,
      subscriptionId,
      planVersionId,
      billableTokens: value.billableTokens ?? value.totalTokens,
      billedAmount: String(value.billedAmount ?? value.cost),
      model: value.model,
      endpoint: value.endpoint,
      status: value.status,
      requests: 1,
      admittedRequests: value.admitted === false ? 0 : 1,
      successes: value.status === 'success' ? 1 : 0,
      failures: value.status === 'success' ? 0 : 1,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      cachedTokens: value.cachedTokens || 0,
      cacheCreationTokens: value.cacheCreationTokens || 0,
      cacheHitRequests: (value.cachedTokens || 0) > 0 ? 1 : 0,
      cacheEligibleRequests: value.inputTokens > 0 ? 1 : 0,
      affinityReuses: value.affinityReused ? 1 : 0,
      affinityFailovers: value.affinityEligible && value.failovers > 0 ? 1 : 0,
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
      target: [usageRollups.bucketStart, usageRollups.granularity, usageRollups.keyId, usageRollups.userId, usageRollups.groupId, usageRollups.model, usageRollups.endpoint, usageRollups.status, usageRollups.channelId, usageRollups.protocolBindingId, usageRollups.protocol, usageRollups.supplySource, usageRollups.poolGroupId, usageRollups.subscriptionId, usageRollups.planVersionId],
      set: {
        requests: sql`${usageRollups.requests} + 1`,
        admittedRequests: sql`${usageRollups.admittedRequests} + ${value.admitted === false ? 0 : 1}`,
        successes: sql`${usageRollups.successes} + ${value.status === 'success' ? 1 : 0}`,
        failures: sql`${usageRollups.failures} + ${value.status === 'success' ? 0 : 1}`,
        inputTokens: sql`${usageRollups.inputTokens} + ${value.inputTokens}`,
        outputTokens: sql`${usageRollups.outputTokens} + ${value.outputTokens}`,
        cachedTokens: sql`${usageRollups.cachedTokens} + ${value.cachedTokens || 0}`,
        cacheCreationTokens: sql`${usageRollups.cacheCreationTokens} + ${value.cacheCreationTokens || 0}`,
        cacheHitRequests: sql`${usageRollups.cacheHitRequests} + ${(value.cachedTokens || 0) > 0 ? 1 : 0}`,
        cacheEligibleRequests: sql`${usageRollups.cacheEligibleRequests} + ${value.inputTokens > 0 ? 1 : 0}`,
        affinityReuses: sql`${usageRollups.affinityReuses} + ${value.affinityReused ? 1 : 0}`,
        affinityFailovers: sql`${usageRollups.affinityFailovers} + ${value.affinityEligible && value.failovers > 0 ? 1 : 0}`,
        totalTokens: sql`${usageRollups.totalTokens} + ${value.totalTokens}`,
        cost: sql`${usageRollups.cost} + ${value.cost}`,
        billableTokens: sql`${usageRollups.billableTokens} + ${value.billableTokens ?? value.totalTokens}`,
        billedAmount: sql`${usageRollups.billedAmount} + ${value.billedAmount ?? value.cost}`,
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
  })
}
