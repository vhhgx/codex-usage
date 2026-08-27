import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import type { ChannelAuthScheme, ChannelModelView, ChannelProtocol, ChannelType, RelayAccountOrderMode, RelayModelScope, RelayPlatformType, UserRelayAccountView, UserRelayGroupView } from '#shared/types/hub'
import { relayProviderPresets } from '#shared/relay-provider-presets'
import { latestModelsByFamily, modelScope } from '#shared/utils/model-routing'
import { useDatabase } from '../db'
import { channelModels, channelProtocolBindings, channels, userModelSourcePreferences, userPoolAccounts, userPoolGroups, userRelayAccountStates, userRelayGroups, userRoutePreferences } from '../db/schema'
import { decryptChannelSecret, decryptContextSecret, encryptChannelSecret, encryptContextSecret } from '../utils/hub-crypto'
import { normalizeUserUpstreamUrl, pinnedUpstreamFetch, resolvePublicUpstream, upstreamNetworkError, userUpstreamTarget } from '../utils/upstream-url'
import { redactSensitiveText } from '../utils/upstream'
import { isClientIdentityRejection, probeAuthSchemes, upstreamAuthHeaders } from '../utils/upstream-auth'
import { upstreamProbeClientIdentity } from '../utils/upstream-client-identity'
import { listChannels, parseChannelModels, parseChannelProtocols, replaceChannelModels, replaceChannelProtocols } from './hub-admin'
import { discoverUpstreamModelIds, modelIdsFromPayload, persistDiscoveredModels, syncChannelModelsFromUpstream } from './hub-model-discovery'
import { invalidateChannelAccess } from './channel-access'
import { channelCircuitState } from './hub-routing'
import { getActiveSubscription } from './customer-management'
import { getUserFailoverSourceIds, PACKAGE_SOURCE_ID, PRIVATE_POOL_SOURCE_ID, relayGroupSourceId } from './user-route-preferences'
import { classifyRelayFailure, parseNewApiBalance, parseSub2ApiBalance, relayPlatform, relayPlatformDefinition, type RelayFailureClass } from './relay-platform'
import { probeUpstreamConnectivity } from './upstream-connectivity'

type Input = Record<string, unknown>
const MAX_USER_RELAY_MODELS = 500

function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function relayType(protocols: Array<{ protocol: ChannelProtocol }>): ChannelType {
  return protocols.some(binding => binding.protocol !== 'anthropic_messages') ? 'openai_compatible' : 'anthropic_compatible'
}

function relayModelScopes(value: unknown, fallback: RelayModelScope[] = []) {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.filter((item): item is RelayModelScope => item === 'gpt' || item === 'claude' || item === 'other'))]
}

function relayPreset(value: unknown) {
  const id = text(value, 100)
  return id ? relayProviderPresets.find(item => item.id === id) || null : null
}

async function validateUserProtocols(protocols: ReturnType<typeof parseChannelProtocols>) {
  for (const protocol of protocols) {
    if (!protocol.baseUrlOverride) continue
    protocol.baseUrlOverride = normalizeUserUpstreamUrl(protocol.baseUrlOverride)
  }
  return protocols
}

function validateModelCount(value: unknown) {
  if (Array.isArray(value) && value.length > MAX_USER_RELAY_MODELS) throw createError({ statusCode: 400, message: `每个中转最多配置 ${MAX_USER_RELAY_MODELS} 个模型` })
}

async function ownedRelay(event: H3Event, ownerUserId: string, id: string) {
  const [relay] = await useDatabase(event).select().from(channels).where(and(
    eq(channels.id, id),
    eq(channels.ownerKind, 'user'),
    eq(channels.ownerUserId, ownerUserId)
  )).limit(1)
  if (!relay) throw createError({ statusCode: 404, message: '中转不存在' })
  return relay
}

export async function listUserRelays(event: H3Event, ownerUserId: string) {
  return listChannels(event, { kind: 'user', userId: ownerUserId })
}

function stateNumber(value: string | null) {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function emptyAccountState() {
  return {
    routingState: 'active' as const,
    stateReasonCode: null,
    stateReasonMessage: null,
    stateChangedAt: null,
    totalQuota: null,
    purchasedQuota: null,
    giftQuota: null,
    usedQuota: null,
    remainingBalance: null,
    currency: null,
    balanceSource: null,
    balanceStatus: 'unknown' as const,
    balanceFetchedAt: null,
    balanceError: null
  }
}

function accountStateView(row: typeof userRelayAccountStates.$inferSelect | undefined) {
  if (!row) return emptyAccountState()
  return {
    routingState: row.routingState,
    stateReasonCode: row.stateReasonCode,
    stateReasonMessage: row.stateReasonMessage,
    stateChangedAt: row.stateChangedAt?.getTime() || null,
    totalQuota: stateNumber(row.totalQuota),
    purchasedQuota: stateNumber(row.purchasedQuota),
    giftQuota: stateNumber(row.giftQuota),
    usedQuota: stateNumber(row.usedQuota),
    remainingBalance: stateNumber(row.remainingBalance),
    currency: row.currency,
    balanceSource: row.balanceSource,
    balanceStatus: row.balanceStatus,
    balanceFetchedAt: row.balanceFetchedAt?.getTime() || null,
    balanceError: row.balanceError
  }
}

export function sortRelayAccounts(accounts: UserRelayAccountView[], mode: RelayAccountOrderMode) {
  const schedulable = (item: UserRelayAccountView) => item.state.routingState === 'active' ? 0 : 1
  return [...accounts].sort((left, right) => {
    const state = schedulable(left) - schedulable(right)
    if (state) return state
    if (mode !== 'manual') {
      const leftBalance = left.state.remainingBalance
      const rightBalance = right.state.remainingBalance
      if (leftBalance !== null || rightBalance !== null) {
        if (leftBalance === null) return 1
        if (rightBalance === null) return -1
        const balance = mode === 'balance_asc' ? leftBalance - rightBalance : rightBalance - leftBalance
        if (balance) return balance
      }
    }
    return left.accountRank - right.accountRank || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  })
}

export async function listUserRelayGroups(event: H3Event, ownerUserId: string): Promise<UserRelayGroupView[]> {
  const db = useDatabase(event)
  const [groups, relays] = await Promise.all([
    db.select().from(userRelayGroups).where(eq(userRelayGroups.ownerUserId, ownerUserId)).orderBy(asc(userRelayGroups.createdAt)),
    listUserRelays(event, ownerUserId)
  ])
  const relayIds = relays.map(relay => relay.id)
  const states = relayIds.length ? await db.select().from(userRelayAccountStates).where(inArray(userRelayAccountStates.channelId, relayIds)) : []
  const stateMap = new Map(states.map(state => [state.channelId, state]))
  return groups.map(group => ({
    id: group.id,
    ownerUserId: group.ownerUserId,
    name: group.name,
    homepageUrl: group.homepageUrl,
    normalizedOrigin: group.normalizedOrigin,
    platformType: group.platformType,
    enabled: group.enabled,
    accountOrderMode: group.accountOrderMode,
    maxConcurrency: group.maxConcurrency,
    accounts: sortRelayAccounts(relays.filter(relay => relay.userRelayGroupId === group.id).map(relay => ({ ...relay, state: accountStateView(stateMap.get(relay.id)) })), group.accountOrderMode),
    createdAt: group.createdAt.getTime(),
    updatedAt: group.updatedAt.getTime()
  }))
}

async function ownedRelayGroup(event: H3Event, ownerUserId: string, id: string) {
  const [group] = await useDatabase(event).select().from(userRelayGroups).where(and(eq(userRelayGroups.id, id), eq(userRelayGroups.ownerUserId, ownerUserId))).limit(1)
  if (!group) throw createError({ statusCode: 404, message: '中转站不存在' })
  return group
}

function balanceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function balanceNumber(value: unknown) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
}

export function newApiBalanceQuotaValues(source: Record<string, unknown>) {
  const purchasedQuota = balanceNumber(source.quota ?? source.purchased_quota ?? source.purchase_quota)
  const giftQuota = balanceNumber(source.gift_quota ?? source.giftQuota)
  const explicitTotal = balanceNumber(source.total_quota ?? source.totalQuota)
  const fallbackQuota = balanceNumber(source.unlimited_quota)
  return {
    quota: explicitTotal ?? (purchasedQuota !== null && giftQuota !== null ? purchasedQuota + giftQuota : purchasedQuota ?? fallbackQuota),
    purchasedQuota,
    giftQuota,
    usedQuota: balanceNumber(source.used_quota ?? source.usedQuota)
  }
}

export async function getUserRelayBalance(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  if (!relay.userRelayGroupId) throw createError({ statusCode: 409, message: '中转账号尚未归入站点组' })
  const group = await ownedRelayGroup(event, ownerUserId, relay.userRelayGroupId)
  const platform = relayPlatformDefinition(group.platformType)
  if (!platform.supportsBalance) throw createError({ statusCode: 409, message: '通用兼容站未配置余额接口' })
  let path: string
  let headers: Record<string, string>
  if (group.platformType === 'newapi') {
    if (!relay.encryptedCheckinToken) throw createError({ statusCode: 409, message: '请先配置 NewAPI 控制台访问令牌' })
    const token = decryptContextSecret(relay.encryptedCheckinToken, `user-relay-checkin:${id}`, event)
    path = '/api/user/self'
    headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
    if (relay.checkinUserId) headers['new-api-user'] = relay.checkinUserId
  } else {
    path = '/v1/usage'
    headers = { authorization: `Bearer ${decryptChannelSecret(relay.encryptedApiKey, relay.id, 'user', event)}`, accept: 'application/json' }
  }
  let result
  try {
    result = await pinnedUpstreamFetch(relay.baseUrl, path, { method: 'GET', headers, signal: AbortSignal.timeout(Math.min(relay.timeoutMs, 30_000)) })
    const raw = await result.response.text()
    await result.close().catch(() => {})
    if (!result.response.ok) throw createError({ statusCode: 502, message: `余额查询失败：HTTP ${result.response.status} ${redactSensitiveText(raw).slice(0, 300)}` })
    let payload: unknown
    try { payload = raw ? JSON.parse(raw) : {} } catch { throw createError({ statusCode: 502, message: '余额接口未返回有效 JSON' }) }
    const values = group.platformType === 'newapi' ? parseNewApiBalance(payload) : parseSub2ApiBalance(payload)
    const now = new Date()
    const depleted = values.remainingBalance !== null && values.remainingBalance <= 0
    await useDatabase(event).insert(userRelayAccountStates).values({
      channelId: id,
      totalQuota: values.totalQuota === null ? null : String(values.totalQuota),
      purchasedQuota: values.purchasedQuota === null ? null : String(values.purchasedQuota),
      giftQuota: values.giftQuota === null ? null : String(values.giftQuota),
      usedQuota: values.usedQuota === null ? null : String(values.usedQuota),
      remainingBalance: values.remainingBalance === null ? null : String(values.remainingBalance),
      currency: values.currency,
      balanceSource: values.source,
      balanceStatus: 'success',
      balanceFetchedAt: now,
      balanceError: null,
      routingState: depleted ? 'depleted' : 'active',
      stateReasonCode: depleted ? 'balance_zero' : null,
      stateReasonMessage: depleted ? '余额刷新结果为零，等待下次手工刷新' : null,
      stateChangedAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: userRelayAccountStates.channelId,
      set: {
        totalQuota: values.totalQuota === null ? null : String(values.totalQuota), purchasedQuota: values.purchasedQuota === null ? null : String(values.purchasedQuota),
        giftQuota: values.giftQuota === null ? null : String(values.giftQuota), usedQuota: values.usedQuota === null ? null : String(values.usedQuota),
        remainingBalance: values.remainingBalance === null ? null : String(values.remainingBalance), currency: values.currency, balanceSource: values.source,
        balanceStatus: 'success', balanceFetchedAt: now, balanceError: null, routingState: depleted ? 'depleted' : 'active',
        stateReasonCode: depleted ? 'balance_zero' : null, stateReasonMessage: depleted ? '余额刷新结果为零，等待下次手工刷新' : null,
        stateChangedAt: now, version: sql`${userRelayAccountStates.version} + 1`, updatedAt: now
      }
    })
    return {
      id, name: relay.name, quota: values.totalQuota, purchasedQuota: values.purchasedQuota, giftQuota: values.giftQuota,
      usedQuota: values.usedQuota, remaining: values.remainingBalance, currency: values.currency, fetchedAt: now.getTime(), routingState: depleted ? 'depleted' : 'active'
    }
  } catch (error) {
    const detail = upstreamNetworkError(error)
    const now = new Date()
    await useDatabase(event).insert(userRelayAccountStates).values({ channelId: id, balanceStatus: 'error', balanceFetchedAt: now, balanceError: detail.message, updatedAt: now })
      .onConflictDoUpdate({ target: userRelayAccountStates.channelId, set: { balanceStatus: 'error', balanceFetchedAt: now, balanceError: detail.message, version: sql`${userRelayAccountStates.version} + 1`, updatedAt: now } })
    throw createError({ statusCode: 502, message: detail.message || '余额查询失败' })
  }
}

export function normalizeUserRelayOrder(currentIds: string[], value: unknown) {
  if (!Array.isArray(value)) throw createError({ statusCode: 400, message: '故障转移顺序格式无效' })
  const orderedIds = value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
  if (orderedIds.length !== currentIds.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some(id => !currentIds.includes(id))) {
    throw createError({ statusCode: 409, message: '来源列表已发生变化，请刷新后重新排序' })
  }
  return orderedIds
}

export async function listUserRelayOrder(event: H3Event, ownerUserId: string) {
  const db = useDatabase(event)
  const [subscription, [privatePool]] = await Promise.all([
    getActiveSubscription(event, ownerUserId),
    db.select().from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  ])
  const groups = await listUserRelayGroups(event, ownerUserId)
  const sourceIds = await getUserFailoverSourceIds(event, ownerUserId, groups.map(group => group.id))
  const relayMap = new Map(groups.map(group => [relayGroupSourceId(group.id), {
    id: relayGroupSourceId(group.id),
    sourceId: group.id,
    sourceType: 'user_relay' as const,
    name: group.name,
    enabled: group.enabled && group.accounts.some(account => account.enabled),
    healthStatus: group.accounts.some(account => account.healthStatus === 'healthy' && account.state.routingState === 'active') ? 'healthy' : group.accounts.some(account => account.healthStatus === 'unknown' && account.state.routingState === 'active') ? 'unknown' : 'unhealthy',
    circuitState: group.accounts.some(account => account.circuitState === 'closed' && account.state.routingState === 'active') ? 'closed' as const : 'open' as const,
    lastHealthCheckAt: group.accounts.reduce<number | null>((latest, account) => Math.max(latest || 0, account.lastHealthCheckAt || 0) || null, null)
  }] as const))
  const packageItem = {
    id: PACKAGE_SOURCE_ID,
    sourceId: subscription?.subscription.id || null,
    sourceType: 'package' as const,
    name: subscription?.plan.name || '当前套餐',
    enabled: Boolean(subscription),
    healthStatus: subscription ? 'healthy' : 'unavailable',
    circuitState: 'closed' as const,
    lastHealthCheckAt: null
  }
  const privatePoolAvailable = Boolean(privatePool && privatePool.status === 'active' && (await db.select({ id: userPoolAccounts.id }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, privatePool.id), eq(userPoolAccounts.status, 'active'), eq(userPoolAccounts.schedulable, true))).limit(1))[0])
  const privatePoolItem = privatePool ? {
    id: PRIVATE_POOL_SOURCE_ID,
    sourceId: privatePool.id,
    sourceType: 'private_pool' as const,
    name: privatePool.displayName,
    enabled: privatePool.status === 'active',
    healthStatus: privatePoolAvailable ? 'healthy' : 'unavailable',
    circuitState: 'closed' as const,
    lastHealthCheckAt: privatePool.lastReconciledAt?.getTime() || null
  } : null
  return sourceIds.map(id => id === PACKAGE_SOURCE_ID ? packageItem : id === PRIVATE_POOL_SOURCE_ID ? privatePoolItem : relayMap.get(id)).filter((item): item is typeof packageItem | NonNullable<typeof privatePoolItem> | NonNullable<ReturnType<typeof relayMap.get>> => Boolean(item))
}

export async function reorderUserRelays(event: H3Event, ownerUserId: string, value: unknown) {
  const db = useDatabase(event)
  const current = await db.select({ id: userRelayGroups.id }).from(userRelayGroups).where(eq(userRelayGroups.ownerUserId, ownerUserId)).orderBy(asc(userRelayGroups.createdAt), asc(userRelayGroups.name))
  const currentSourceIds = await getUserFailoverSourceIds(event, ownerUserId, current.map(group => group.id))
  const orderedIds = normalizeUserRelayOrder(currentSourceIds, value)
  const updatedAt = new Date()
  await db.insert(userRoutePreferences).values({ userId: ownerUserId, orderedSourceIds: orderedIds, updatedAt }).onConflictDoUpdate({ target: userRoutePreferences.userId, set: { orderedSourceIds: orderedIds, updatedAt } })
  const relayGroupIds = orderedIds.filter(id => id.startsWith('relay_group:')).map(id => id.slice(12))
  for (const [index, id] of relayGroupIds.entries()) {
    await db.update(channels).set({ priority: (index + 1) * 10, updatedAt }).where(and(eq(channels.userRelayGroupId, id), eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  }
  await invalidateChannelAccess(event, (await db.select({ id: channels.id }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))).map(row => row.id))
  return listUserRelayOrder(event, ownerUserId)
}

export async function getUserRelay(event: H3Event, ownerUserId: string, id: string) {
  await ownedRelay(event, ownerUserId, id)
  return (await listUserRelays(event, ownerUserId)).find(channel => channel.id === id)!
}

async function discoverPrivateModels(baseUrl: string, apiKey: string, timeoutMs: number, protocols: ReturnType<typeof parseChannelProtocols>) {
  const preferred = protocols.find(binding => binding.protocol === 'openai_responses')
    || protocols.find(binding => binding.protocol === 'openai_chat')
    || protocols[0]
  if (!preferred) return []
  const ids = await discoverUpstreamModelIds(preferred.baseUrlOverride || baseUrl, apiKey, timeoutMs, {
    authScheme: preferred.authScheme,
    apiVersion: preferred.apiVersion,
    privateUrl: true
  })
  return ids.slice(0, MAX_USER_RELAY_MODELS).map(upstreamModel => ({
    publicModel: upstreamModel,
    upstreamModel,
    enabled: true,
    endpoints: [],
    protocolBindings: protocols.map(protocol => ({ protocol: protocol.protocol, upstreamModel, enabled: true, capabilities: { streaming: true, tools: true } }))
  } satisfies ChannelModelView))
}

export async function discoverUserRelayModels(event: H3Event, ownerUserId: string, body: Input) {
  const relayId = text(body.relayId, 100)
  const relay = relayId ? await ownedRelay(event, ownerUserId, relayId) : null
  const baseUrl = normalizeUserUpstreamUrl(text(body.baseUrl, 1000) || relay?.baseUrl || '')
  const apiKey = text(body.apiKey, 2000) || (relay ? decryptChannelSecret(relay.encryptedApiKey, relay.id, 'user', event) : '')
  if (!baseUrl || !apiKey) throw createError({ statusCode: 400, message: '请先填写中转地址和 API Key' })
  await resolvePublicUpstream(baseUrl)
  const configured = relayId
    ? await useDatabase(event).select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, relayId))
    : []
  const attempts = configured.length
    ? configured
    : [
        { protocol: 'openai_responses' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null },
        { protocol: 'anthropic_messages' as const, authScheme: 'x_api_key' as const, apiVersion: '2023-06-01', baseUrlOverride: null }
      ]
  let lastError: unknown
  for (const protocol of attempts) {
    try {
      const ids = await discoverUpstreamModelIds(protocol.baseUrlOverride || baseUrl, apiKey, integer(body.timeoutMs, 1000, 600000, relay?.timeoutMs || 120000), {
        authScheme: protocol.authScheme,
        apiVersion: protocol.apiVersion,
        privateUrl: true
      })
      return { models: ids.slice(0, MAX_USER_RELAY_MODELS) }
    } catch (error) { lastError = error }
  }
  throw lastError
}

export async function createUserRelay(event: H3Event, ownerUserId: string, body: Input) {
  const allowed = new Set(['name', 'baseUrl', 'apiKey', 'protocols', 'models', 'enabled', 'weight', 'maxConcurrency', 'timeoutMs', 'checkinEnabled', 'checkinToken', 'checkinUserId', 'clientIdentityMode', 'groupId', 'groupName', 'platformType', 'accountLabel', 'homepageUrl', 'insecureHttpAcknowledged', 'providerPresetId', 'providerFamily', 'productType', 'modelScopes'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能设置字段：${invalid.join(', ')}` })
  const db = useDatabase(event)
  const name = text(body.name, 120)
  const apiKey = text(body.apiKey, 2000)
  const checkinToken = text(body.checkinToken, 4096)
  const checkinEnabled = body.checkinEnabled === true
  const baseUrl = normalizeUserUpstreamUrl(text(body.baseUrl, 1000))
  if (!name || !apiKey) throw createError({ statusCode: 400, message: '名称、地址和 API Key 均为必填项' })
  const requestedPlatform = relayPlatform(body.platformType)
  let group = text(body.groupId, 100) ? await ownedRelayGroup(event, ownerUserId, text(body.groupId, 100)) : null
  if (group && 'platformType' in body && group.platformType !== requestedPlatform) throw createError({ statusCode: 409, message: '同一站点组的平台类型必须一致' })
  if (!group) {
    const requestedGroupName = text(body.groupName, 120)
    const origin = new URL(baseUrl).origin.toLowerCase()
    const candidates = await db.select().from(userRelayGroups).where(and(eq(userRelayGroups.ownerUserId, ownerUserId), eq(userRelayGroups.platformType, requestedPlatform))).orderBy(asc(userRelayGroups.createdAt))
    group = candidates.find(candidate => candidate.normalizedOrigin === origin || candidate.name.trim().toLowerCase() === requestedGroupName.toLowerCase()) || null
  }
  const platformType: RelayPlatformType = group?.platformType || requestedPlatform
  const platform = relayPlatformDefinition(platformType)
  if (checkinEnabled && !platform.supportsCheckin) throw createError({ statusCode: 400, message: `${platform.label} 不支持 Hub 签到` })
  if (checkinEnabled && !checkinToken) throw createError({ statusCode: 400, message: '启用签到时必须填写控制台访问令牌' })
  const insecureHttp = new URL(baseUrl).protocol === 'http:'
  if (insecureHttp && body.insecureHttpAcknowledged !== true) throw createError({ statusCode: 400, message: '使用 HTTP 中转前必须确认 API Key 和请求内容将以明文传输' })
  validateModelCount(body.models)
  const preset = relayPreset(body.providerPresetId)
  const presetProtocols = preset?.protocols.map(item => ({ ...item, enabled: true, baseUrlOverride: item.baseUrlOverride || null, apiVersion: item.protocol === 'anthropic_messages' ? '2023-06-01' : null, probeModel: preset.defaultModels?.[0] || null, capabilityMode: 'native' as const })) || []
  const provisionalType: ChannelType = presetProtocols.some(item => item.protocol === 'anthropic_messages') && !presetProtocols.some(item => item.protocol !== 'anthropic_messages') ? 'anthropic_compatible' : 'openai_compatible'
  const protocols = presetProtocols.length ? await validateUserProtocols(presetProtocols) : []
  if (!group) {
    const [createdGroup] = await db.insert(userRelayGroups).values({
      ownerUserId,
      name: text(body.groupName, 120) || name,
      homepageUrl: normalizeUserUpstreamUrl(text(body.homepageUrl, 1000) || baseUrl),
      normalizedOrigin: new URL(baseUrl).origin.toLowerCase(),
      platformType,
      enabled: body.enabled !== false
    }).returning()
    group = createdGroup || null
  }
  if (!group) throw createError({ statusCode: 500, message: '创建中转站失败' })
  const [lastRank] = await db.select({ value: max(channels.accountRank) }).from(channels).where(eq(channels.userRelayGroupId, group.id))
  const [lastPriority] = await db.select({ value: max(channels.priority) }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  const id = randomUUID()
  const timeoutMs = integer(body.timeoutMs, 1000, 600000, 120000)
  const models = parseChannelModels(body.models)
  const scopes = preset?.modelScopes?.length ? preset.modelScopes : relayModelScopes(body.modelScopes)
  if (!preset && !scopes.length) throw createError({ statusCode: 400, message: '请至少选择一个模型品类' })
  const [created] = await db.insert(channels).values({
    id,
    name,
    type: platformType === 'sub2api' ? 'sub2api' : relayType(protocols),
    baseUrl,
    encryptedApiKey: encryptChannelSecret(apiKey, id, 'user', event),
    ownerKind: 'user',
    ownerUserId,
    userRelayGroupId: group.id,
    accountLabel: text(body.accountLabel, 120) || name,
    accountRank: Math.min(10000, Number(lastRank?.value || 0) + 10),
    providerPresetId: preset?.id || null,
    providerFamily: preset?.providerFamily || text(body.providerFamily, 100) || null,
    productType: preset?.productType || text(body.productType, 50) || 'generic',
    modelScopes: scopes,
    accessScope: 'private',
    createdBy: ownerUserId,
    credentialKeyVersion: 'v2',
    enabled: body.enabled !== false,
    priority: Math.min(10000, Number(lastPriority?.value || 0) + 10),
    weight: integer(body.weight, 1, 1000, 1),
    maxConcurrency: integer(body.maxConcurrency, 1, 1000, 5),
    timeoutMs,
    clientIdentityMode: body.clientIdentityMode === 'passthrough' ? 'passthrough' : 'standard',
    insecureHttpAcknowledgedAt: insecureHttp ? new Date() : null,
    checkinEnabled,
    encryptedCheckinToken: checkinToken ? encryptContextSecret(checkinToken, `user-relay-checkin:${id}`, event) : null,
    checkinUserId: text(body.checkinUserId, 120) || null
  }).returning()
  if (!created) throw createError({ statusCode: 500, message: '创建中转失败' })
  const protocolRows = protocols.length ? await replaceChannelProtocols(event, id, protocols) : []
  if (models.length) await replaceChannelModels(event, id, models, protocolRows)
  await db.insert(userRelayAccountStates).values({ channelId: id }).onConflictDoNothing()
  return getUserRelay(event, ownerUserId, id)
}

export async function updateUserRelay(event: H3Event, ownerUserId: string, id: string, body: Input) {
  const relay = await ownedRelay(event, ownerUserId, id)
  const allowed = new Set(['name', 'baseUrl', 'apiKey', 'protocols', 'models', 'enabled', 'weight', 'maxConcurrency', 'timeoutMs', 'checkinEnabled', 'checkinToken', 'checkinUserId', 'clientIdentityMode', 'accountLabel', 'insecureHttpAcknowledged', 'providerPresetId', 'providerFamily', 'productType', 'modelScopes'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能修改字段：${invalid.join(', ')}` })
  const patch: Partial<typeof channels.$inferInsert> = { updatedAt: new Date() }
  if ('name' in body) patch.name = text(body.name, 120) || relay.name
  if ('baseUrl' in body) {
    patch.baseUrl = normalizeUserUpstreamUrl(text(body.baseUrl, 1000))
    if (new URL(patch.baseUrl).protocol === 'http:' && body.insecureHttpAcknowledged !== true && !relay.insecureHttpAcknowledgedAt) throw createError({ statusCode: 400, message: '使用 HTTP 中转前必须确认 API Key 和请求内容将以明文传输' })
    patch.insecureHttpAcknowledgedAt = new URL(patch.baseUrl).protocol === 'http:' ? relay.insecureHttpAcknowledgedAt || new Date() : null
  }
  if (text(body.apiKey, 2000)) patch.encryptedApiKey = encryptChannelSecret(text(body.apiKey, 2000), relay.id, 'user', event)
  if ('enabled' in body) patch.enabled = body.enabled === true
  if ('weight' in body) patch.weight = integer(body.weight, 1, 1000, relay.weight)
  if ('maxConcurrency' in body) patch.maxConcurrency = integer(body.maxConcurrency, 1, 1000, relay.maxConcurrency)
  if ('timeoutMs' in body) patch.timeoutMs = integer(body.timeoutMs, 1000, 600000, relay.timeoutMs)
  if ('clientIdentityMode' in body) patch.clientIdentityMode = body.clientIdentityMode === 'passthrough' ? 'passthrough' : 'standard'
  if ('accountLabel' in body) patch.accountLabel = text(body.accountLabel, 120) || relay.accountLabel || relay.name
  if ('providerFamily' in body) patch.providerFamily = text(body.providerFamily, 100) || null
  if ('productType' in body) patch.productType = text(body.productType, 50) || 'generic'
  if ('modelScopes' in body) {
    const scopes = relayModelScopes(body.modelScopes)
    if (!relay.providerPresetId && !scopes.length) throw createError({ statusCode: 400, message: '请至少选择一个模型品类' })
    patch.modelScopes = scopes
  }
  if ('clientIdentityMode' in body || 'protocols' in body || 'baseUrl' in body || text(body.apiKey, 2000)) {
    patch.healthStatus = 'unknown'
    patch.lastHealthError = null
  }
  const checkinToken = text(body.checkinToken, 4096)
  if (checkinToken) patch.encryptedCheckinToken = encryptContextSecret(checkinToken, `user-relay-checkin:${id}`, event)
  if ('checkinEnabled' in body) {
    if (body.checkinEnabled === true && !checkinToken && !relay.encryptedCheckinToken) throw createError({ statusCode: 400, message: '启用签到时必须填写 NewAPI 控制台访问令牌' })
    patch.checkinEnabled = body.checkinEnabled === true
  }
  if ('checkinUserId' in body) patch.checkinUserId = text(body.checkinUserId, 120) || null
  validateModelCount(body.models)
  let protocols = await useDatabase(event).select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, id))
  if ('protocols' in body) {
    const parsed = await validateUserProtocols(parseChannelProtocols(body.protocols, relay.type))
    protocols = await replaceChannelProtocols(event, id, parsed)
    if (parsed.length) patch.type = relayType(parsed)
  }
  await useDatabase(event).update(channels).set(patch).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId)))
  if ('models' in body) {
    const models = parseChannelModels(body.models)
    await replaceChannelModels(event, id, models, protocols)
  } else if ('protocols' in body) {
    const models = await useDatabase(event).select().from(channelModels).where(eq(channelModels.channelId, id))
    await replaceChannelModels(event, id, models.map(model => ({ publicModel: model.publicModel, upstreamModel: model.upstreamModel, enabled: model.enabled, endpoints: model.endpoints })), protocols)
  }
  await invalidateChannelAccess(event, [id])
  return getUserRelay(event, ownerUserId, id)
}

function testPayload(protocol: ChannelProtocol, model: string) {
  if (protocol === 'anthropic_messages') return { path: '/v1/messages', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK' }] } }
  if (protocol === 'openai_responses') return { path: '/v1/responses', body: { model, max_output_tokens: 1, input: 'Reply OK' } }
  return { path: '/v1/chat/completions', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK' }] } }
}

export async function testUserRelay(event: H3Event, ownerUserId: string, id: string, requestedModel = '') {
  const relay = await ownedRelay(event, ownerUserId, id)
  const db = useDatabase(event)
  const configuredProtocols = await db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, id))
  const apiKey = decryptChannelSecret(relay.encryptedApiKey, relay.id, 'user', event)
  const firstProtocol = configuredProtocols[0]
  const connectivity = {
    endpoint: userUpstreamTarget(firstProtocol?.baseUrlOverride || relay.baseUrl, '/v1/models'),
    ok: false,
    reachable: false,
    status: null as number | null,
    latencyMs: 0,
    errorCode: null as string | null,
    message: null as string | null,
    modelCount: 0,
    authScheme: (firstProtocol?.authScheme || 'bearer') as ChannelAuthScheme,
    attemptedAuthSchemes: [] as ChannelAuthScheme[]
  }
  const connectivityStarted = Date.now()
  let discoveredModels: string[] = []
  try {
    const probe = await probeAuthSchemes(connectivity.authScheme, async (authScheme) => {
      const result = await pinnedUpstreamFetch(firstProtocol?.baseUrlOverride || relay.baseUrl, '/v1/models', {
        method: 'GET',
        headers: upstreamAuthHeaders(authScheme, apiKey, firstProtocol?.apiVersion),
        signal: AbortSignal.timeout(Math.min(relay.timeoutMs, 15000))
      })
      connectivity.endpoint = result.target
      const body = await result.response.text()
      const response = { ok: result.response.ok, status: result.response.status, body }
      await result.close().catch(() => {})
      return response
    })
    const final = probe.attempts.at(-1)!
    connectivity.reachable = true
    connectivity.ok = probe.ok
    connectivity.status = final.status
    connectivity.authScheme = probe.selectedAuthScheme || final.authScheme
    connectivity.attemptedAuthSchemes = probe.attempts.map(attempt => attempt.authScheme)
    if (probe.ok) {
      try { discoveredModels = modelIdsFromPayload(JSON.parse(final.body)); connectivity.modelCount = discoveredModels.length } catch {}
      if (!connectivity.modelCount) connectivity.message = '模型接口可访问，但没有识别到模型；检测不会自动修改模型目录'
    } else {
      connectivity.errorCode = final.status ? `HTTP_${final.status}` : 'UPSTREAM_ERROR'
      connectivity.message = `${final.status ? `HTTP ${final.status}: ` : ''}${redactSensitiveText(final.body)}`.slice(0, 500)
    }
  } catch (error) {
    const detail = upstreamNetworkError(error)
    connectivity.errorCode = detail.code
    connectivity.message = detail.message
  }
  connectivity.latencyMs = Date.now() - connectivityStarted
  const latest = latestModelsByFamily(discoveredModels)
  const latestByScope = (scope: RelayModelScope) => latest.find(item => modelScope(item.model) === scope)?.model
  const fallbackModel = latest[0]?.model || null
  const preset = relayPreset(relay.providerPresetId)
  const candidateProtocols: Array<{ protocol: ChannelProtocol; authScheme: ChannelAuthScheme; apiVersion: string | null; baseUrlOverride: string | null; probeModel: string | null }> = configuredProtocols.length
    ? configuredProtocols.map(item => ({ protocol: item.protocol, authScheme: item.authScheme, apiVersion: item.apiVersion, baseUrlOverride: item.baseUrlOverride, probeModel: item.probeModel }))
    : (preset?.protocols.length
        ? preset.protocols.map(item => ({ protocol: item.protocol, authScheme: item.authScheme, apiVersion: item.protocol === 'anthropic_messages' ? '2023-06-01' : null, baseUrlOverride: item.baseUrlOverride || null, probeModel: null }))
        : [
            ...(relay.modelScopes.includes('gpt') ? [{ protocol: 'openai_responses' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null, probeModel: null }, { protocol: 'openai_chat' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null, probeModel: null }] : []),
            ...(relay.modelScopes.includes('claude') ? [{ protocol: 'anthropic_messages' as const, authScheme: 'x_api_key' as const, apiVersion: '2023-06-01', baseUrlOverride: null, probeModel: null }] : []),
            ...(relay.modelScopes.length === 1 && relay.modelScopes[0] === 'other' ? [{ protocol: 'openai_responses' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null, probeModel: null }, { protocol: 'openai_chat' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null, probeModel: null }] : [])
          ])
  const results: Array<Record<string, unknown> & { protocol: ChannelProtocol; ok: boolean; clientIdentityRejected: boolean }> = []
  for (const protocol of connectivity.reachable && discoveredModels.length ? candidateProtocols : []) {
    const expectedScope: RelayModelScope = protocol.protocol === 'anthropic_messages' ? 'claude' : relay.modelScopes.includes('gpt') ? 'gpt' : 'other'
    const model = requestedModel && discoveredModels.includes(requestedModel) ? requestedModel : protocol.probeModel && discoveredModels.includes(protocol.probeModel) ? protocol.probeModel : latestByScope(expectedScope) || fallbackModel
    if (!model) continue
    const payload = testPayload(protocol.protocol, model)
    let ok = false
    let message: string | null = null
    let errorCode: string | null = null
    let status: number | null = null
    let endpoint = userUpstreamTarget(protocol.baseUrlOverride || relay.baseUrl, payload.path)
    const started = Date.now()
    let selectedAuthScheme: ChannelAuthScheme | null = null
    let attempts: Array<{ authScheme: ChannelAuthScheme; ok: boolean; status: number | null; body: string }> = []
    try {
      const probe = await probeAuthSchemes(protocol.authScheme, async (authScheme) => {
        const clientIdentity = relay.clientIdentityMode === 'passthrough' ? upstreamProbeClientIdentity(protocol.protocol) : {}
        const headers = { 'content-type': 'application/json', ...clientIdentity, ...upstreamAuthHeaders(authScheme, apiKey, protocol.apiVersion) }
        const result = await pinnedUpstreamFetch(protocol.baseUrlOverride || relay.baseUrl, payload.path, {
          method: 'POST', headers, body: JSON.stringify(payload.body), signal: AbortSignal.timeout(Math.min(relay.timeoutMs, 30000))
        })
        endpoint = result.target
        const responseBody = await result.response.text()
        const response = { ok: result.response.ok, status: result.response.status, body: responseBody }
        await result.close().catch(() => {})
        return response
      })
      ok = probe.ok
      selectedAuthScheme = probe.selectedAuthScheme
      attempts = probe.attempts
      const final = attempts.at(-1)!
      status = final.status
      errorCode = ok ? null : status ? `HTTP_${status}` : 'UPSTREAM_ERROR'
      message = ok ? null : `${status ? `HTTP ${status}: ` : ''}${redactSensitiveText(final.body)}`.slice(0, 500)
      if (probe.changed && selectedAuthScheme) {
        // The selected scheme is persisted with the detected capability below.
      }
    } catch (error) {
      const detail = upstreamNetworkError(error)
      errorCode = detail.code
      message = detail.message
    }
    const clientIdentityRejected = attempts.some(attempt => isClientIdentityRejection(attempt.body))
    const verificationStatus = ok ? 'verified' : clientIdentityRejected ? 'pending_real_client' : 'failed'
    results.push({ protocol: protocol.protocol, endpoint, ok, status, latencyMs: Date.now() - started, errorCode, message, authScheme: selectedAuthScheme || protocol.authScheme, attemptedAuthSchemes: attempts.map(attempt => attempt.authScheme), clientIdentityRejected, clientIdentityProbed: relay.clientIdentityMode === 'passthrough', model, verificationStatus, baseUrlOverride: protocol.baseUrlOverride, apiVersion: protocol.apiVersion })
    if (protocol.protocol === 'openai_responses' && ok && !configuredProtocols.length) {
      // Native Responses is preferred; Chat is only a fallback capability.
      const chatIndex = candidateProtocols.findIndex(item => item.protocol === 'openai_chat')
      if (chatIndex >= 0) candidateProtocols.splice(chatIndex, 1)
    }
  }
  if (connectivity.reachable && discoveredModels.length) {
    const protocolRows = await replaceChannelProtocols(event, id, results.map((result) => ({
      protocol: result.protocol,
      enabled: result.ok || result.clientIdentityRejected,
      baseUrlOverride: typeof result.baseUrlOverride === 'string' ? result.baseUrlOverride : null,
      authScheme: result.authScheme === 'x_api_key' ? 'x_api_key' : 'bearer',
      apiVersion: typeof result.apiVersion === 'string' ? result.apiVersion : null,
      probeModel: typeof result.model === 'string' ? result.model : null,
      capabilityMode: result.protocol === 'openai_chat' && !results.some(item => item.protocol === 'openai_responses' && item.ok) ? 'responses_via_chat' : 'native'
    })))
    for (const row of protocolRows) {
      const result = results.find(item => item.protocol === row.protocol)
      if (!result) continue
      await db.update(channelProtocolBindings).set({
        verificationStatus: result.verificationStatus === 'verified' || result.verificationStatus === 'pending_real_client' ? result.verificationStatus : 'failed',
        capabilityMode: row.protocol === 'openai_chat' && !results.some(item => item.protocol === 'openai_responses' && item.ok) ? 'responses_via_chat' : 'native',
        detectedAt: new Date(),
        verifiedAt: new Date(),
        lastError: typeof result.message === 'string' ? result.message : null,
        updatedAt: new Date()
      }).where(eq(channelProtocolBindings.id, row.id))
    }
    await persistDiscoveredModels(event, id, discoveredModels)
  }
  const passed = results.filter(result => result.ok).length
  const pendingClientVerification = results.some(result => result.clientIdentityRejected)
  const healthy = passed > 0
  const summaryStatus = !connectivity.reachable ? 'unavailable' : passed === results.length && results.length ? 'all_available' : healthy ? 'partially_available' : pendingClientVerification ? 'pending_real_client' : 'unavailable'
  const healthStatus = healthy ? 'healthy' : pendingClientVerification ? 'unknown' : 'unhealthy'
  const lastHealthError = summaryStatus === 'all_available' ? null
    : !connectivity.reachable ? connectivity.message
      : pendingClientVerification && !healthy ? '上游要求受支持的客户端身份，等待真实 Claude Code / Codex 请求验证'
        : results.filter(result => !result.ok).map(result => `${result.protocol}: ${result.errorCode ? `[${result.errorCode}] ` : ''}${result.message || '检测失败'}`).join('\n').slice(0, 2000)
  await db.update(channels).set({ healthStatus, lastHealthCheckAt: new Date(), lastHealthError, updatedAt: new Date() }).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId)))
  return { healthy, summaryStatus, pendingClientVerification, connectivity, results }
}

export async function testUserRelayConnectivity(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  return probeUpstreamConnectivity(relay.baseUrl)
}

export async function testUserRelayModel(event: H3Event, ownerUserId: string, id: string, model: unknown) {
  const selected = text(model, 200)
  if (!selected) throw createError({ statusCode: 400, message: '请选择要测试的模型' })
  return testUserRelay(event, ownerUserId, id, selected)
}

export async function syncUserRelayModels(event: H3Event, ownerUserId: string, id: string) {
  await ownedRelay(event, ownerUserId, id)
  const result = await syncChannelModelsFromUpstream(event, id)
  await invalidateChannelAccess(event, [id])
  return result
}

function checkinResponseMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== 'object') return fallback
  const body = value as Record<string, unknown>
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim()
  if (body.error && typeof body.error === 'object' && typeof (body.error as Record<string, unknown>).message === 'string') return String((body.error as Record<string, unknown>).message)
  return fallback
}

export function interpretRelayCheckinResponse(statusCode: number, payload: unknown, raw = '') {
  const message = redactSensitiveText(checkinResponseMessage(payload, raw || `HTTP ${statusCode}`)).slice(0, 500)
  const responseBody = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const already = /(?:今日)?已签到/.test(message)
  const success = statusCode >= 200 && statusCode < 300 && (responseBody?.success === true || already)
  const data = responseBody?.data && typeof responseBody.data === 'object' ? responseBody.data as Record<string, unknown> : null
  return {
    status: already ? 'already' as const : success ? 'success' as const : statusCode === 404 ? 'unsupported' as const : 'failed' as const,
    message,
    awardedQuota: Number.isFinite(Number(data?.quota_awarded)) ? Number(data?.quota_awarded) : null
  }
}

export async function checkinUserRelay(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  if (!relay.checkinEnabled || !relay.encryptedCheckinToken) throw createError({ statusCode: 409, message: '该中转未启用 NewAPI 签到' })
  const attemptedAt = new Date()
  let status: 'success' | 'already' | 'unsupported' | 'failed' = 'failed'
  let message = '签到失败'
  let awardedQuota: number | null = null
  try {
    const token = decryptContextSecret(relay.encryptedCheckinToken, `user-relay-checkin:${id}`, event)
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    if (relay.checkinUserId) headers['new-api-user'] = relay.checkinUserId
    const result = await pinnedUpstreamFetch(relay.baseUrl, '/api/user/checkin', {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(Math.min(relay.timeoutMs, 30_000))
    })
    const raw = await result.response.text()
    await result.close().catch(() => {})
    let payload: unknown = null
    try { payload = raw ? JSON.parse(raw) : null } catch {}
    const interpreted = interpretRelayCheckinResponse(result.response.status, payload, raw)
    status = interpreted.status
    message = interpreted.message
    awardedQuota = interpreted.awardedQuota
  } catch (error) {
    const detail = upstreamNetworkError(error)
    message = detail.message
  }
  await useDatabase(event).update(channels).set({
    lastCheckinAt: attemptedAt,
    lastCheckinStatus: status,
    lastCheckinMessage: message,
    updatedAt: attemptedAt
  }).where(and(eq(channels.id, id), eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  return { id, name: relay.name, success: status === 'success' || status === 'already', status, message, awardedQuota, checkedInAt: attemptedAt.getTime() }
}

export async function checkinAllUserRelays(event: H3Event, ownerUserId: string) {
  const relays = await useDatabase(event).select({ id: channels.id, name: channels.name }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId), eq(channels.checkinEnabled, true)))
  const results = await Promise.all(relays.map(async relay => {
    try { return await checkinUserRelay(event, ownerUserId, relay.id) }
    catch (error) {
      const failure = error as { message?: string }
      return { id: relay.id, name: relay.name, success: false, status: 'failed' as const, message: failure.message || '签到失败', awardedQuota: null, checkedInAt: Date.now() }
    }
  }))
  return { results, summary: { total: results.length, success: results.filter(result => result.success).length, failed: results.filter(result => !result.success).length } }
}

export async function updateUserRelayGroup(event: H3Event, ownerUserId: string, id: string, body: Input) {
  const group = await ownedRelayGroup(event, ownerUserId, id)
  const db = useDatabase(event)
  const patch: Partial<typeof userRelayGroups.$inferInsert> = { updatedAt: new Date() }
  if ('name' in body) patch.name = text(body.name, 120) || group.name
  if ('homepageUrl' in body) {
    const rawHomepage = text(body.homepageUrl, 1000)
    if (rawHomepage) {
      const homepage = normalizeUserUpstreamUrl(rawHomepage)
      patch.homepageUrl = homepage
      patch.normalizedOrigin = new URL(homepage).origin.toLowerCase()
    } else {
      patch.homepageUrl = null
      patch.normalizedOrigin = null
    }
  }
  if ('enabled' in body) patch.enabled = body.enabled === true
  if ('accountOrderMode' in body && (body.accountOrderMode === 'manual' || body.accountOrderMode === 'balance_asc' || body.accountOrderMode === 'balance_desc')) patch.accountOrderMode = body.accountOrderMode
  if ('maxConcurrency' in body) patch.maxConcurrency = body.maxConcurrency === null ? null : integer(body.maxConcurrency, 1, 10000, group.maxConcurrency || 100)
  if ('platformType' in body) {
    const next = relayPlatform(body.platformType)
    patch.platformType = next
    if (next !== 'newapi') await db.update(channels).set({ checkinEnabled: false, updatedAt: new Date() }).where(eq(channels.userRelayGroupId, id))
    if (next !== group.platformType) {
      const accountIds = await db.select({ id: channels.id }).from(channels).where(eq(channels.userRelayGroupId, id))
      if (accountIds.length) await db.update(channelProtocolBindings).set({ verificationStatus: 'unknown', verifiedAt: null, lastError: null, updatedAt: new Date() }).where(inArray(channelProtocolBindings.channelId, accountIds.map(item => item.id)))
    }
  }
  await db.update(userRelayGroups).set(patch).where(and(eq(userRelayGroups.id, id), eq(userRelayGroups.ownerUserId, ownerUserId)))
  return (await listUserRelayGroups(event, ownerUserId)).find(item => item.id === id)!
}

export async function reorderUserRelayAccounts(event: H3Event, ownerUserId: string, groupId: string, value: unknown) {
  await ownedRelayGroup(event, ownerUserId, groupId)
  const db = useDatabase(event)
  const current = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.userRelayGroupId, groupId), eq(channels.ownerUserId, ownerUserId), eq(channels.ownerKind, 'user'))).orderBy(asc(channels.accountRank), asc(channels.createdAt))
  if (!Array.isArray(value)) throw createError({ statusCode: 400, message: '账号顺序格式无效' })
  const ordered = value.filter((item): item is string => typeof item === 'string' && current.some(row => row.id === item))
  if (ordered.length !== current.length || new Set(ordered).size !== current.length) throw createError({ statusCode: 409, message: '账号列表已变化，请刷新后重新排序' })
  const now = new Date()
  await db.transaction(async tx => {
    for (const [index, id] of ordered.entries()) await tx.update(channels).set({ accountRank: (index + 1) * 10, updatedAt: now }).where(eq(channels.id, id))
  })
  return (await listUserRelayGroups(event, ownerUserId)).find(item => item.id === groupId)!
}

export async function moveUserRelayAccount(event: H3Event, ownerUserId: string, groupId: string, channelId: string, targetGroupId: string) {
  const source = await ownedRelayGroup(event, ownerUserId, groupId)
  const target = await ownedRelayGroup(event, ownerUserId, targetGroupId)
  const relay = await ownedRelay(event, ownerUserId, channelId)
  if (relay.userRelayGroupId !== source.id) throw createError({ statusCode: 409, message: '账号不属于当前站点，请刷新后重试' })
  if (source.id === target.id) return target
  const db = useDatabase(event)
  const [last] = await db.select({ rank: max(channels.accountRank) }).from(channels).where(eq(channels.userRelayGroupId, target.id))
  await db.update(channels).set({
    userRelayGroupId: target.id,
    accountRank: Number(last?.rank || 0) + 10,
    checkinEnabled: target.platformType === 'newapi' ? relay.checkinEnabled : false,
    updatedAt: new Date()
  }).where(and(eq(channels.id, channelId), eq(channels.ownerUserId, ownerUserId)))
  const [remaining] = await db.select({ count: sql<number>`count(*)` }).from(channels).where(eq(channels.userRelayGroupId, source.id))
  if (Number(remaining?.count || 0) === 0) {
    await db.delete(userRelayGroups).where(eq(userRelayGroups.id, source.id))
    const [preference] = await db.select().from(userRoutePreferences).where(eq(userRoutePreferences.userId, ownerUserId)).limit(1)
    if (preference) {
      const sourceId = relayGroupSourceId(source.id)
      await db.update(userRoutePreferences).set({ orderedSourceIds: preference.orderedSourceIds.filter(id => id !== sourceId), updatedAt: new Date() }).where(eq(userRoutePreferences.userId, ownerUserId))
    }
  }
  await invalidateChannelAccess(event, [channelId])
  return (await listUserRelayGroups(event, ownerUserId)).find(group => group.id === target.id)!
}

export async function mergeUserRelayGroups(event: H3Event, ownerUserId: string, targetGroupId: string, sourceGroupIds: unknown) {
  const target = await ownedRelayGroup(event, ownerUserId, targetGroupId)
  if (!Array.isArray(sourceGroupIds)) throw createError({ statusCode: 400, message: '待合并站点格式无效' })
  const ids = [...new Set(sourceGroupIds.filter((id): id is string => typeof id === 'string' && id !== target.id))]
  if (!ids.length) return target
  const sources: Array<typeof userRelayGroups.$inferSelect> = []
  for (const id of ids) sources.push(await ownedRelayGroup(event, ownerUserId, id))
  const db = useDatabase(event)
  const targetRows = await db.select({ rank: channels.accountRank }).from(channels).where(eq(channels.userRelayGroupId, target.id))
  let rank = Math.max(0, ...targetRows.map(row => row.rank))
  const movedIds: string[] = []
  await db.transaction(async tx => {
    for (const source of sources) {
      const accounts = await tx.select({ id: channels.id }).from(channels).where(eq(channels.userRelayGroupId, source.id)).orderBy(asc(channels.accountRank), asc(channels.createdAt))
      for (const account of accounts) {
        rank += 10; movedIds.push(account.id)
        await tx.update(channels).set({ userRelayGroupId: target.id, accountRank: rank, checkinEnabled: target.platformType === 'newapi' ? undefined : false, updatedAt: new Date() }).where(eq(channels.id, account.id))
      }
      await tx.delete(userRelayGroups).where(eq(userRelayGroups.id, source.id))
    }
    const [preference] = await tx.select().from(userRoutePreferences).where(eq(userRoutePreferences.userId, ownerUserId)).limit(1)
    if (preference) {
      const mergedIds = new Set([relayGroupSourceId(target.id), ...sources.map(source => relayGroupSourceId(source.id))])
      const first = preference.orderedSourceIds.findIndex(id => mergedIds.has(id))
      const retained = preference.orderedSourceIds.filter(id => !mergedIds.has(id))
      retained.splice(first < 0 ? retained.length : first, 0, relayGroupSourceId(target.id))
      await tx.update(userRoutePreferences).set({ orderedSourceIds: retained, updatedAt: new Date() }).where(eq(userRoutePreferences.userId, ownerUserId))
    }
  })
  await invalidateChannelAccess(event, movedIds)
  return (await listUserRelayGroups(event, ownerUserId)).find(group => group.id === target.id)!
}

export async function getUserRelayCredentials(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  return {
    id,
    apiKey: decryptChannelSecret(relay.encryptedApiKey, relay.id, 'user', event),
    checkinToken: relay.encryptedCheckinToken ? decryptContextSecret(relay.encryptedCheckinToken, `user-relay-checkin:${id}`, event) : '',
    checkinUserId: relay.checkinUserId || ''
  }
}

export async function duplicateUserRelay(event: H3Event, ownerUserId: string, id: string, body: Input) {
  const relay = await ownedRelay(event, ownerUserId, id)
  const view = (await listUserRelays(event, ownerUserId)).find(item => item.id === id)
  if (!view) throw createError({ statusCode: 404, message: '中转账号不存在' })
  const credentials = await getUserRelayCredentials(event, ownerUserId, id)
  const createInGroup = body.newGroup !== true
  const result = await createUserRelay(event, ownerUserId, {
    name: text(body.name, 120) || `${relay.name} - 副本`,
    accountLabel: text(body.accountLabel, 120) || `${relay.accountLabel || relay.name} - 副本`,
    groupId: createInGroup ? relay.userRelayGroupId || undefined : undefined,
    groupName: createInGroup ? undefined : text(body.groupName, 120) || `${relay.name} - 副本`,
    homepageUrl: createInGroup ? undefined : text(body.homepageUrl, 1000) || relay.baseUrl,
    platformType: createInGroup
      ? relay.userRelayGroupId ? (await ownedRelayGroup(event, ownerUserId, relay.userRelayGroupId)).platformType : 'generic'
      : relayPlatform(body.platformType),
    baseUrl: text(body.baseUrl, 1000) || relay.baseUrl,
    apiKey: text(body.apiKey, 2000) || credentials.apiKey,
    providerPresetId: relay.providerPresetId || undefined,
    providerFamily: relay.providerFamily || undefined,
    productType: relay.productType,
    modelScopes: relay.modelScopes,
    protocols: view.protocols.map(protocol => ({ ...protocol, verificationStatus: 'unknown', verifiedAt: null, lastError: null })),
    models: view.models,
    enabled: body.enabled === undefined ? true : body.enabled,
    weight: relay.weight,
    maxConcurrency: relay.maxConcurrency,
    timeoutMs: relay.timeoutMs,
    checkinEnabled: body.checkinEnabled === undefined ? relay.checkinEnabled : body.checkinEnabled,
    checkinToken: text(body.checkinToken, 4096) || credentials.checkinToken,
    checkinUserId: text(body.checkinUserId, 120) || credentials.checkinUserId,
    clientIdentityMode: relay.clientIdentityMode,
    insecureHttpAcknowledged: new URL(text(body.baseUrl, 1000) || relay.baseUrl).protocol === 'http:'
  })
  return result
}

async function removeRelayGroupFromPreferences(event: H3Event, ownerUserId: string, groupId: string) {
  const db = useDatabase(event)
  const sourceId = relayGroupSourceId(groupId)
  const [preference, modelSources] = await Promise.all([
    db.select().from(userRoutePreferences).where(eq(userRoutePreferences.userId, ownerUserId)).limit(1),
    db.select().from(userModelSourcePreferences).where(eq(userModelSourcePreferences.userId, ownerUserId))
  ])
  if (preference[0]) await db.update(userRoutePreferences).set({ orderedSourceIds: preference[0].orderedSourceIds.filter(id => id !== sourceId), updatedAt: new Date() }).where(eq(userRoutePreferences.userId, ownerUserId))
  for (const row of modelSources) {
    if (!row.orderedSourceIds.includes(sourceId)) continue
    await db.update(userModelSourcePreferences).set({ orderedSourceIds: row.orderedSourceIds.filter(id => id !== sourceId), updatedAt: new Date() }).where(eq(userModelSourcePreferences.id, row.id))
  }
}

export async function deleteUserRelayGroup(event: H3Event, ownerUserId: string, id: string, deleteAccounts = false) {
  await ownedRelayGroup(event, ownerUserId, id)
  const [summary] = await useDatabase(event).select({ count: sql<number>`count(*)` }).from(channels).where(and(eq(channels.userRelayGroupId, id), eq(channels.ownerUserId, ownerUserId)))
  if (Number(summary?.count || 0) > 0 && !deleteAccounts) throw createError({ statusCode: 409, message: '站点内仍有账号；请明确确认删除全部账号，或先把账号移动到其他站点' })
  const [deleted] = await useDatabase(event).delete(userRelayGroups).where(and(eq(userRelayGroups.id, id), eq(userRelayGroups.ownerUserId, ownerUserId))).returning({ id: userRelayGroups.id })
  if (!deleted) throw createError({ statusCode: 404, message: '中转站不存在' })
  await removeRelayGroupFromPreferences(event, ownerUserId, id)
  await invalidateChannelAccess(event, [])
  return { success: true }
}

export async function refreshUserRelayGroupBalances(event: H3Event, ownerUserId: string, groupId: string) {
  const group = await ownedRelayGroup(event, ownerUserId, groupId)
  const accounts = await useDatabase(event).select({ id: channels.id, name: channels.name }).from(channels).where(and(eq(channels.userRelayGroupId, group.id), eq(channels.ownerUserId, ownerUserId), eq(channels.ownerKind, 'user'))).orderBy(asc(channels.accountRank))
  const results = []
  for (const account of accounts) {
    try { results.push({ ...(await getUserRelayBalance(event, ownerUserId, account.id)), success: true }) }
    catch (error) { results.push({ id: account.id, name: account.name, success: false, message: error instanceof Error ? error.message : '余额查询失败' }) }
  }
  return { groupId, results }
}

export async function refreshAllUserRelayBalances(event: H3Event, ownerUserId: string) {
  const groups = await useDatabase(event).select({ id: userRelayGroups.id }).from(userRelayGroups).where(eq(userRelayGroups.ownerUserId, ownerUserId))
  const results = []
  for (const group of groups) results.push(await refreshUserRelayGroupBalances(event, ownerUserId, group.id))
  return { results }
}

export async function markUserRelayFailure(event: H3Event | undefined, channelId: string, failureClass: RelayFailureClass, message: string) {
  if (failureClass !== 'quota_exhausted' && failureClass !== 'credential_error') return
  const routingState = failureClass === 'quota_exhausted' ? 'depleted' as const : 'credential_error' as const
  const now = new Date()
  await useDatabase(event).insert(userRelayAccountStates).values({
    channelId,
    routingState,
    stateReasonCode: failureClass,
    stateReasonMessage: redactSensitiveText(message).slice(0, 500),
    stateChangedAt: now,
    updatedAt: now
  }).onConflictDoUpdate({
    target: userRelayAccountStates.channelId,
    set: { routingState, stateReasonCode: failureClass, stateReasonMessage: redactSensitiveText(message).slice(0, 500), stateChangedAt: now, version: sql`${userRelayAccountStates.version} + 1`, updatedAt: now }
  })
}

export async function deleteUserRelay(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  const [deleted] = await useDatabase(event).delete(channels).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId), eq(channels.ownerKind, 'user'))).returning({ id: channels.id })
  if (!deleted) throw createError({ statusCode: 404, message: '中转不存在' })
  if (relay.userRelayGroupId) {
    const [summary] = await useDatabase(event).select({ count: sql<number>`count(*)` }).from(channels).where(eq(channels.userRelayGroupId, relay.userRelayGroupId))
    if (Number(summary?.count || 0) === 0) {
      await useDatabase(event).delete(userRelayGroups).where(eq(userRelayGroups.id, relay.userRelayGroupId))
      await removeRelayGroupFromPreferences(event, ownerUserId, relay.userRelayGroupId)
    }
  }
  await invalidateChannelAccess(event, [id])
  return { success: true }
}
