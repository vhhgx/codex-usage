import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { useDatabase } from '../db'
import { channelModelBindings, channelModels, channelProtocolBindings, channels, groupChannelRules, modelPools, userPoolAccounts, userPoolGroups } from '../db/schema'
import { decryptChannelSecret, decryptContextSecret } from '../utils/hub-crypto'
import { useRedis } from '../utils/redis'
import { getHubSettings } from './hub-settings'
import { applyGroupChannelPolicy } from './group-policy'
import { visibleChannels } from './channel-access'

export interface RouteCandidate {
  channel: typeof channels.$inferSelect
  upstreamModel: string
  protocolBinding: typeof channelProtocolBindings.$inferSelect
  modelBinding: typeof channelModelBindings.$inferSelect
  conversionMode: 'passthrough' | 'anthropic_to_openai' | 'openai_to_anthropic'
  affinityReused: boolean
  supplySource: 'platform' | 'private_pool' | 'user_relay'
  credentialSource: 'channel' | 'user_pool' | 'user_relay'
  credentialRef?: string
  credential?: string
}

export interface SupplyDecision {
  source: 'platform' | 'private_pool' | 'user_relay'
  subscriptionId: string | null
  planVersionId: string | null
  reservedTokens: number
  walletHoldId?: string
  poolGroupId?: string
}

export function keyRouteSources(mode: 'platform_only' | 'private_only' | 'platform_then_private' | 'private_then_platform') {
  if (mode === 'private_only') return ['user_relay'] as const
  if (mode === 'platform_then_private') return ['platform', 'user_relay'] as const
  if (mode === 'private_then_platform') return ['user_relay', 'platform'] as const
  return ['platform'] as const
}

export function selectSupplySource(input: {
  billingMode: string
  supplyMode: string
  estimatedTokens: number
  remainingTokens: number | null
  privatePoolAvailable: boolean
  subscriptionId?: string | null
  planVersionId?: string | null
  poolGroupId?: string | null
}): SupplyDecision {
  const base = { subscriptionId: input.subscriptionId || null, planVersionId: input.planVersionId || null, reservedTokens: 0 }
  if (input.supplyMode === 'private_only') return { ...base, source: 'private_pool', poolGroupId: input.poolGroupId || undefined }
  if (input.billingMode === 'token_package' && input.supplyMode === 'platform_then_private') {
    if (input.remainingTokens !== null && input.remainingTokens >= Math.max(0, input.estimatedTokens)) return { ...base, source: 'platform', reservedTokens: Math.max(0, input.estimatedTokens) }
    if (!input.privatePoolAvailable) throw createError({ statusCode: 429, message: '套餐额度已用尽，专属号池当前不可用', data: { code: 'private_pool_unavailable' } })
    return { ...base, source: 'private_pool', poolGroupId: input.poolGroupId || undefined }
  }
  return { ...base, source: 'platform', reservedTokens: input.billingMode === 'token_package' ? Math.max(0, input.estimatedTokens) : 0 }
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

function endpointProtocol(endpoint: string) {
  if (endpoint === '/v1/responses') return 'openai_responses' as const
  if (endpoint === '/v1/messages') return 'anthropic_messages' as const
  return 'openai_chat' as const
}

const ROUTING_ADAPTER_VERSION = 'v1'

function affinityIdentity(candidate: RouteCandidate) {
  return `${candidate.channel.id}:${candidate.protocolBinding.id}:${candidate.credentialRef || 'default'}:${candidate.upstreamModel}:${ROUTING_ADAPTER_VERSION}`
}

function rendezvousScore(key: string, candidate: RouteCandidate) {
  const raw = createHash('sha256').update(`${key}:${affinityIdentity(candidate)}`).digest().readUIntBE(0, 6)
  const unit = (raw + 1) / 281474976710657
  return -Math.log(unit) / Math.max(1, candidate.channel.weight)
}

async function applyAffinity(event: H3Event, candidates: RouteCandidate[], affinityKey?: string) {
  if (!affinityKey || candidates.length < 2) return candidates
  const redis = useRedis(event)
  const key = `hub:affinity:${affinityKey}`
  const quality = candidates[0]!.conversionMode
  const qualityCandidates = candidates.filter(candidate => candidate.conversionMode === quality)
  const topPriority = qualityCandidates[0]!.channel.priority
  const peers = qualityCandidates.filter(candidate => candidate.channel.priority === topPriority)
  const existing = await redis.get(key)
  if (existing) {
    const candidate = peers.find(item => affinityIdentity(item) === existing)
    if (candidate) return [{ ...candidate, affinityReused: true }, ...candidates.filter(item => item !== candidate)]
  }
  const selected = [...peers].sort((left, right) => rendezvousScore(affinityKey, left) - rendezvousScore(affinityKey, right))[0] || candidates[0]!
  await redis.set(key, affinityIdentity(selected), 'EX', 7200)
  return [selected, ...candidates.filter(item => item !== selected)]
}

export async function rememberAffinitySelection(event: H3Event, affinityKey: string | undefined, candidate: RouteCandidate) {
  if (!affinityKey) return
  await useRedis(event).set(`hub:affinity:${affinityKey}`, affinityIdentity(candidate), 'EX', 7200)
}

export async function routeCandidates(
  event: H3Event,
  publicModel: string,
  endpoint: string,
  groupId: string | null = null,
  supplySource: 'platform' | 'private_pool' | 'user_relay' = 'platform',
  poolGroupId?: string,
  options: { userId?: string; keyId?: string; protocol?: 'anthropic_messages' | 'openai_responses' | 'openai_chat'; allowConversion?: boolean; affinityKey?: string } = {}
) {
  const db = useDatabase(event)
  const requestedProtocol = options.protocol || endpointProtocol(endpoint)
  const rows = await db.select({ channel: channels, model: channelModels, modelBinding: channelModelBindings, protocolBinding: channelProtocolBindings })
    .from(channelModelBindings)
    .innerJoin(channelModels, eq(channelModelBindings.channelModelId, channelModels.id))
    .innerJoin(channelProtocolBindings, eq(channelModelBindings.protocolBindingId, channelProtocolBindings.id))
    .innerJoin(channels, eq(channelModels.channelId, channels.id))
    .where(and(
      eq(channelModels.publicModel, publicModel),
      eq(channelModels.enabled, true),
      eq(channelModelBindings.enabled, true),
      eq(channelProtocolBindings.enabled, true),
      eq(channels.enabled, true)
    ))
    .orderBy(asc(channels.priority), asc(channels.name))
  const visible = options.userId ? await visibleChannels(event, options.userId, options.keyId) : []
  const visibleIds = new Set(visible.map(channel => channel.id))
  const rules = groupId && supplySource !== 'user_relay'
    ? await db.select().from(groupChannelRules).where(eq(groupChannelRules.groupId, groupId))
    : []
  const eligible = applyGroupChannelPolicy(
    rows.filter((row) => {
      const protocolMatches = row.protocolBinding.protocol === requestedProtocol
        || options.allowConversion === true && requestedProtocol === 'anthropic_messages' && row.protocolBinding.protocol === 'openai_chat'
      const capabilityEndpoint = requestedProtocol === 'anthropic_messages' && row.protocolBinding.protocol === 'openai_chat'
        ? '/v1/chat/completions'
        : endpoint
      const sourceMatches = supplySource === 'platform'
        ? row.channel.ownerKind === 'platform'
        : supplySource === 'user_relay'
          ? row.channel.ownerKind === 'user' && row.channel.ownerUserId === options.userId
          : row.channel.ownerKind === 'platform' && row.channel.type === 'sub2api'
      return row.channel.healthStatus === 'healthy'
        && (!options.userId || visibleIds.has(row.channel.id) || supplySource === 'private_pool')
        && sourceMatches
        && protocolMatches
        && (!row.model.endpoints.length || row.model.endpoints.includes(capabilityEndpoint))
    }),
    rules
  )
  const redis = useRedis(event)
  const settings = await getHubSettings(event)
  let available: RouteCandidate[] = []
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
    available.push({
      channel: row.channel,
      upstreamModel: row.modelBinding.upstreamModel,
      protocolBinding: row.protocolBinding,
      modelBinding: row.modelBinding,
      supplySource,
      credentialSource: row.channel.ownerKind === 'user' ? 'user_relay' : 'channel',
      credentialRef: row.channel.ownerKind === 'user' ? row.channel.id : undefined,
      credential: row.channel.ownerKind === 'user' ? decryptChannelSecret(row.channel.encryptedApiKey, row.channel.id, 'user', event) : undefined,
      conversionMode: requestedProtocol === row.protocolBinding.protocol ? 'passthrough' : requestedProtocol === 'anthropic_messages' ? 'anthropic_to_openai' : 'openai_to_anthropic',
      affinityReused: false
    })
  }
  available.sort((left, right) => Number(left.conversionMode !== 'passthrough') - Number(right.conversionMode !== 'passthrough') || left.channel.priority - right.channel.priority || left.channel.name.localeCompare(right.channel.name))
  const [pool] = await db.select().from(modelPools).where(eq(modelPools.publicModel, publicModel)).limit(1)
  if (pool?.enabled === false) return []
  if (halfOpen.size) {
    const credentialed = await applyPrivateCredential(event, [...available].sort((left, right) => Number(halfOpen.has(right.channel.id)) - Number(halfOpen.has(left.channel.id))), supplySource, poolGroupId)
    return applyAffinity(event, credentialed, options.affinityKey)
  }
  const credentialed = await applyPrivateCredential(event, available, supplySource, poolGroupId)
  if (pool?.strategy !== 'weighted_round_robin' || credentialed.length < 2) return applyAffinity(event, credentialed, options.affinityKey)
  return applyAffinity(event, credentialed, options.affinityKey || `${publicModel}:${Date.now()}:${Math.random()}`)
}

async function applyPrivateCredential(event: H3Event, candidates: RouteCandidate[], source: 'platform' | 'private_pool' | 'user_relay', poolGroupId?: string) {
  if (source !== 'private_pool') return candidates
  if (!poolGroupId) return []
  const db = useDatabase(event)
  const [pool] = await db.select().from(userPoolGroups).where(eq(userPoolGroups.id, poolGroupId)).limit(1)
  const [account] = await db.select({ id: userPoolAccounts.id }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, poolGroupId), eq(userPoolAccounts.status, 'active'), eq(userPoolAccounts.schedulable, true))).limit(1)
  if (!pool || !account || pool.status !== 'active') return []
  let credential: string
  try { credential = decryptContextSecret(pool.encryptedUpstreamApiKey, `user-pool:${pool.id}`, event) } catch { return [] }
  return candidates.map(candidate => ({ ...candidate, credentialSource: 'user_pool' as const, credentialRef: pool.id, credential }))
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
