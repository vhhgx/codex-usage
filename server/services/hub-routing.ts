import { and, asc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelModels, channels, groupChannelRules, modelPools } from '../db/schema'
import { useRedis } from '../utils/redis'
import { getHubSettings } from './hub-settings'
import { applyGroupChannelPolicy } from './group-policy'

export interface RouteCandidate {
  channel: typeof channels.$inferSelect
  upstreamModel: string
}

export async function channelCircuitState(event: H3Event | undefined, channelId: string) {
  const redis = useRedis(event)
  const prefix = `hub:circuit:${channelId}`
  if (await redis.exists(`${prefix}:open`)) return 'open' as const
  if (await redis.exists(`${prefix}:half-open`)) return 'half_open' as const
  const failures = Number(await redis.get(`${prefix}:failures`) || 0)
  const threshold = (await getHubSettings(event)).circuitFailureThreshold
  return failures >= threshold ? 'half_open' as const : 'closed' as const
}

export async function routeCandidates(event: H3Event, publicModel: string, endpoint: string, groupId: string | null = null) {
  const db = useDatabase(event)
  const rows = await db.select({ channel: channels, model: channelModels })
    .from(channelModels)
    .innerJoin(channels, eq(channelModels.channelId, channels.id))
    .where(and(
      eq(channelModels.publicModel, publicModel),
      eq(channelModels.enabled, true),
      eq(channels.enabled, true)
    ))
    .orderBy(asc(channels.priority), asc(channels.name))
  const rules = groupId
    ? await db.select().from(groupChannelRules).where(eq(groupChannelRules.groupId, groupId))
    : []
  const eligible = applyGroupChannelPolicy(
    rows.filter(row => row.channel.healthStatus === 'healthy' && (!row.model.endpoints.length || row.model.endpoints.includes(endpoint))),
    rules
  )
  const redis = useRedis(event)
  const settings = await getHubSettings(event)
  const available: RouteCandidate[] = []
  const halfOpen = new Set<string>()
  for (const row of eligible) {
    const prefix = `hub:circuit:${row.channel.id}`
    if (await redis.exists(`${prefix}:open`)) continue
    const failures = Number(await redis.get(`${prefix}:failures`) || 0)
    if (failures >= settings.circuitFailureThreshold) {
      const probe = await redis.set(`${prefix}:half-open`, '1', 'PX', settings.circuitCooldownMs, 'NX')
      if (!probe) continue
      halfOpen.add(row.channel.id)
    }
    available.push({ channel: row.channel, upstreamModel: row.model.upstreamModel })
  }
  const [pool] = await db.select().from(modelPools).where(eq(modelPools.publicModel, publicModel)).limit(1)
  if (pool?.enabled === false) return []
  if (halfOpen.size) {
    return [...available].sort((left, right) => Number(halfOpen.has(right.channel.id)) - Number(halfOpen.has(left.channel.id)))
  }
  if (pool?.strategy !== 'weighted_round_robin' || available.length < 2) return available
  const totalWeight = available.reduce((sum, item) => sum + Math.max(1, item.channel.weight), 0)
  const cursor = await redis.incr(`hub:routing:${publicModel}:cursor`)
  let position = (cursor - 1) % totalWeight
  const selected = available.find((item) => {
    position -= Math.max(1, item.channel.weight)
    return position < 0
  }) || available[0]!
  return [selected, ...available.filter(item => item.channel.id !== selected.channel.id)]
}

export async function recordChannelFailure(event: H3Event, channelId: string, message: string) {
  const redis = useRedis(event)
  const settings = await getHubSettings(event)
  const failureKey = `hub:circuit:${channelId}:failures`
  const failures = await redis.incr(failureKey)
  await redis.expire(failureKey, Math.ceil(settings.circuitCooldownMs / 1000) * 2)
  if (failures >= settings.circuitFailureThreshold) {
    await redis.set(`hub:circuit:${channelId}:open`, message.slice(0, 500), 'PX', settings.circuitCooldownMs)
  }
  await redis.del(`hub:circuit:${channelId}:half-open`)
}

export async function recordChannelSuccess(event: H3Event | undefined, channelId: string) {
  await useRedis(event).del(
    `hub:circuit:${channelId}:failures`,
    `hub:circuit:${channelId}:open`,
    `hub:circuit:${channelId}:half-open`
  )
}
