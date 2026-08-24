import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray, max } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import type { ChannelModelView, ChannelProtocol, ChannelType } from '#shared/types/hub'
import { useDatabase } from '../db'
import { channelModelBindings, channelModels, channelProtocolBindings, channels, userPoolAccounts, userPoolGroups, userRoutePreferences } from '../db/schema'
import { decryptChannelSecret, decryptContextSecret, encryptChannelSecret, encryptContextSecret } from '../utils/hub-crypto'
import { normalizeUserUpstreamUrl, pinnedUpstreamFetch, resolvePublicUpstream, upstreamNetworkError, userUpstreamTarget } from '../utils/upstream-url'
import { redactSensitiveText } from '../utils/upstream'
import { listChannels, parseChannelModels, parseChannelProtocols, replaceChannelModels, replaceChannelProtocols } from './hub-admin'
import { discoverUpstreamModelIds, mergeDiscoveredModelMappings, syncChannelModelsFromUpstream } from './hub-model-discovery'
import { invalidateChannelAccess } from './channel-access'
import { channelCircuitState } from './hub-routing'
import { getActiveSubscription } from './customer-management'
import { getUserFailoverSourceIds, PACKAGE_SOURCE_ID, PRIVATE_POOL_SOURCE_ID, relaySourceId } from './user-route-preferences'

type Input = Record<string, unknown>
const MAX_USER_RELAYS = 10
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

async function validateUserProtocols(protocols: ReturnType<typeof parseChannelProtocols>) {
  for (const protocol of protocols) {
    if (!protocol.baseUrlOverride) continue
    protocol.baseUrlOverride = normalizeUserUpstreamUrl(protocol.baseUrlOverride)
    await resolvePublicUpstream(protocol.baseUrlOverride)
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
  return (await listChannels(event)).filter(channel => channel.ownerKind === 'user' && channel.ownerUserId === ownerUserId)
}

function balanceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function getUserRelayBalance(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  if (!relay.encryptedCheckinToken) throw createError({ statusCode: 409, message: '请先在中转设置中配置 NewAPI 访问令牌' })
  const token = decryptContextSecret(relay.encryptedCheckinToken, `user-relay-checkin:${id}`, event)
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
  if (relay.checkinUserId) headers['new-api-user'] = relay.checkinUserId
  let result
  try {
    result = await pinnedUpstreamFetch(relay.baseUrl, '/api/user/self', { method: 'GET', headers, signal: AbortSignal.timeout(Math.min(relay.timeoutMs, 30_000)) })
    const raw = await result.response.text()
    await result.close().catch(() => {})
    let payload: unknown = null
    try { payload = raw ? JSON.parse(raw) : null } catch {}
    const root = balanceRecord(payload)
    const data = balanceRecord(root.data)
    const nested = balanceRecord(data.data)
    const source = Object.keys(nested).length ? nested : data
    const number = (value: unknown) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
    const ratio = 500_000
    const exchangeRate = 1
    const rawQuota = number(source.quota ?? source.unlimited_quota ?? source.total_quota)
    const rawUsedQuota = number(source.used_quota ?? source.usedQuota)
    const quota = rawQuota === null ? null : rawQuota / ratio * exchangeRate
    const usedQuota = rawUsedQuota === null ? null : rawUsedQuota / ratio * exchangeRate
    // NewAPI 的 quota 字段是当前余额，used_quota 是历史消耗；与 switch 的默认配额模式一致。
    return { id, name: relay.name, quota, usedQuota, remaining: quota, currency: typeof source.currency === 'string' ? source.currency : 'CNY', fetchedAt: Date.now() }
  } catch (error) {
    const detail = upstreamNetworkError(error)
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
  const relays = await db.select({
    id: channels.id,
    name: channels.name,
    priority: channels.priority,
    enabled: channels.enabled,
    healthStatus: channels.healthStatus,
    lastHealthCheckAt: channels.lastHealthCheckAt,
    lastHealthError: channels.lastHealthError
  }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId))).orderBy(asc(channels.priority), asc(channels.name))
  const sourceIds = await getUserFailoverSourceIds(event, ownerUserId, relays.map(relay => relay.id))
  const relayMap = new Map(await Promise.all(relays.map(async relay => [relaySourceId(relay.id), {
    id: relaySourceId(relay.id),
    sourceId: relay.id,
    sourceType: 'user_relay' as const,
    name: relay.name,
    enabled: relay.enabled,
    healthStatus: relay.healthStatus,
    circuitState: await channelCircuitState(event, relay.id),
    lastHealthCheckAt: relay.lastHealthCheckAt?.getTime() || null
  }] as const)))
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
  const current = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId))).orderBy(asc(channels.priority), asc(channels.name))
  const currentSourceIds = await getUserFailoverSourceIds(event, ownerUserId, current.map(relay => relay.id))
  const orderedIds = normalizeUserRelayOrder(currentSourceIds, value)
  const updatedAt = new Date()
  await db.insert(userRoutePreferences).values({ userId: ownerUserId, orderedSourceIds: orderedIds, updatedAt }).onConflictDoUpdate({ target: userRoutePreferences.userId, set: { orderedSourceIds: orderedIds, updatedAt } })
  const relayIds = orderedIds.filter(id => id.startsWith('relay:')).map(id => id.slice(6))
  for (const [index, id] of relayIds.entries()) {
    await db.update(channels).set({ priority: (index + 1) * 10, updatedAt }).where(and(eq(channels.id, id), eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  }
  await invalidateChannelAccess(event, relayIds)
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

export async function createUserRelay(event: H3Event, ownerUserId: string, body: Input) {
  const allowed = new Set(['name', 'baseUrl', 'apiKey', 'protocols', 'models', 'enabled', 'weight', 'maxConcurrency', 'timeoutMs', 'checkinEnabled', 'checkinToken', 'checkinUserId'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能设置字段：${invalid.join(', ')}` })
  const [existing] = await useDatabase(event).select({ value: count() }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  if (Number(existing?.value || 0) >= MAX_USER_RELAYS) throw createError({ statusCode: 409, message: `每个用户最多添加 ${MAX_USER_RELAYS} 个中转` })
  const [lastPriority] = await useDatabase(event).select({ value: max(channels.priority) }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  const name = text(body.name, 120)
  const apiKey = text(body.apiKey, 2000)
  const checkinToken = text(body.checkinToken, 4096)
  const checkinEnabled = body.checkinEnabled === true
  const baseUrl = normalizeUserUpstreamUrl(text(body.baseUrl, 1000))
  if (!name || !apiKey) throw createError({ statusCode: 400, message: '名称、地址和 API Key 均为必填项' })
  if (checkinEnabled && !checkinToken) throw createError({ statusCode: 400, message: '启用签到时必须填写 NewAPI 控制台访问令牌' })
  await resolvePublicUpstream(baseUrl)
  validateModelCount(body.models)
  const provisionalType: ChannelType = Array.isArray(body.protocols) && body.protocols.some(item => item && typeof item === 'object' && (item as Input).protocol === 'anthropic_messages') ? 'anthropic_compatible' : 'openai_compatible'
  const protocols = await validateUserProtocols(parseChannelProtocols(body.protocols, provisionalType))
  if (!protocols.length) throw createError({ statusCode: 400, message: '请至少选择一种上游协议' })
  const id = randomUUID()
  const timeoutMs = integer(body.timeoutMs, 1000, 600000, 120000)
  let models = parseChannelModels(body.models)
  try {
    const discovered = await discoverPrivateModels(baseUrl, apiKey, timeoutMs, protocols)
    models = [...new Map([...discovered, ...models].map(model => [model.publicModel, model])).values()]
  } catch (error) {
    if (!models.length) throw error
  }
  const [created] = await useDatabase(event).insert(channels).values({
    id,
    name,
    type: relayType(protocols),
    baseUrl,
    encryptedApiKey: encryptChannelSecret(apiKey, id, 'user', event),
    ownerKind: 'user',
    ownerUserId,
    accessScope: 'private',
    createdBy: ownerUserId,
    credentialKeyVersion: 'v2',
    enabled: body.enabled !== false,
    priority: Math.min(10000, Number(lastPriority?.value || 0) + 10),
    weight: integer(body.weight, 1, 1000, 1),
    maxConcurrency: integer(body.maxConcurrency, 1, 1000, 5),
    timeoutMs,
    checkinEnabled,
    encryptedCheckinToken: checkinToken ? encryptContextSecret(checkinToken, `user-relay-checkin:${id}`, event) : null,
    checkinUserId: text(body.checkinUserId, 120) || null
  }).returning()
  if (!created) throw createError({ statusCode: 500, message: '创建中转失败' })
  const protocolRows = await replaceChannelProtocols(event, id, protocols)
  await replaceChannelModels(event, id, models, protocolRows)
  return getUserRelay(event, ownerUserId, id)
}

export async function updateUserRelay(event: H3Event, ownerUserId: string, id: string, body: Input) {
  const relay = await ownedRelay(event, ownerUserId, id)
  const allowed = new Set(['name', 'baseUrl', 'apiKey', 'protocols', 'models', 'enabled', 'weight', 'maxConcurrency', 'timeoutMs', 'checkinEnabled', 'checkinToken', 'checkinUserId'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能修改字段：${invalid.join(', ')}` })
  const patch: Partial<typeof channels.$inferInsert> = { updatedAt: new Date() }
  if ('name' in body) patch.name = text(body.name, 120) || relay.name
  if ('baseUrl' in body) {
    patch.baseUrl = normalizeUserUpstreamUrl(text(body.baseUrl, 1000))
    await resolvePublicUpstream(patch.baseUrl)
  }
  if (text(body.apiKey, 2000)) patch.encryptedApiKey = encryptChannelSecret(text(body.apiKey, 2000), relay.id, 'user', event)
  if ('enabled' in body) patch.enabled = body.enabled === true
  if ('weight' in body) patch.weight = integer(body.weight, 1, 1000, relay.weight)
  if ('maxConcurrency' in body) patch.maxConcurrency = integer(body.maxConcurrency, 1, 1000, relay.maxConcurrency)
  if ('timeoutMs' in body) patch.timeoutMs = integer(body.timeoutMs, 1000, 600000, relay.timeoutMs)
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
    if (!parsed.length) throw createError({ statusCode: 400, message: '请至少选择一种上游协议' })
    protocols = await replaceChannelProtocols(event, id, parsed)
    patch.type = relayType(parsed)
  }
  await useDatabase(event).update(channels).set(patch).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId)))
  if ('models' in body) {
    await replaceChannelModels(event, id, parseChannelModels(body.models), protocols)
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

export function selectRelayProbeModel(protocol: ChannelProtocol, models: string[]) {
  const score = (model: string) => {
    const value = model.toLowerCase()
    let result = 0
    if (/image|embedding|audio|tts|whisper|dall[.-]?e|moderation|rerank|auto-review/.test(value)) result -= 100
    if (protocol === 'anthropic_messages' && value.includes('claude')) result += 60
    if (protocol === 'openai_responses' && (value.includes('codex') || value.includes('responses'))) result += 50
    if (protocol !== 'anthropic_messages' && value.startsWith('gpt-')) result += 40
    if (protocol === 'openai_chat' && (value.startsWith('grok-') || value.startsWith('claude-'))) result += 30
    if (/^(?:gpt|grok|claude)-\d+(?:\.\d+)*$/.test(value)) result += 20
    return result
  }
  return [...new Set(models)].sort((left, right) => score(right) - score(left) || left.localeCompare(right))[0] || null
}

export async function testUserRelay(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  try { await syncChannelModelsFromUpstream(event, id) } catch {}
  const protocols = await useDatabase(event).select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, id))
  const apiKey = decryptChannelSecret(relay.encryptedApiKey, relay.id, 'user', event)
  const results = []
  for (const protocol of protocols) {
    const modelBindings = await useDatabase(event).select({ upstreamModel: channelModelBindings.upstreamModel })
      .from(channelModelBindings)
      .innerJoin(channelModels, eq(channelModelBindings.channelModelId, channelModels.id))
      .where(and(eq(channelModelBindings.protocolBindingId, protocol.id), eq(channelModelBindings.enabled, true), eq(channelModels.enabled, true)))
    const model = selectRelayProbeModel(protocol.protocol, modelBindings.map(binding => binding.upstreamModel))
    if (!model) {
      const message = '该协议没有启用的模型绑定'
      await useDatabase(event).update(channelProtocolBindings).set({ verificationStatus: 'failed', verifiedAt: new Date(), lastError: message, updatedAt: new Date() }).where(and(eq(channelProtocolBindings.id, protocol.id), eq(channelProtocolBindings.channelId, relay.id)))
      results.push({ protocol: protocol.protocol, endpoint: userUpstreamTarget(protocol.baseUrlOverride || relay.baseUrl, testPayload(protocol.protocol, '').path), ok: false, status: null, latencyMs: 0, errorCode: 'MODEL_BINDING_MISSING', message })
      continue
    }
    const payload = testPayload(protocol.protocol, model)
    let ok = false
    let message: string | null = null
    let errorCode: string | null = null
    let status: number | null = null
    let endpoint = userUpstreamTarget(protocol.baseUrlOverride || relay.baseUrl, payload.path)
    const started = Date.now()
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (protocol.authScheme === 'x_api_key') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = protocol.apiVersion || '2023-06-01'
      } else headers.authorization = `Bearer ${apiKey}`
      const result = await pinnedUpstreamFetch(protocol.baseUrlOverride || relay.baseUrl, payload.path, {
        method: 'POST', headers, body: JSON.stringify(payload.body), signal: AbortSignal.timeout(Math.min(relay.timeoutMs, 30000))
      })
      endpoint = result.target
      const text = await result.response.text()
      status = result.response.status
      await result.close().catch(() => {})
      ok = result.response.ok
      errorCode = ok ? null : `HTTP_${result.response.status}`
      message = ok ? null : `HTTP ${result.response.status}: ${redactSensitiveText(text)}`.slice(0, 500)
    } catch (error) {
      const detail = upstreamNetworkError(error)
      errorCode = detail.code
      message = detail.message
    }
    await useDatabase(event).update(channelProtocolBindings).set({ verificationStatus: ok ? 'verified' : 'failed', verifiedAt: new Date(), lastError: message, updatedAt: new Date() }).where(and(eq(channelProtocolBindings.id, protocol.id), eq(channelProtocolBindings.channelId, relay.id)))
    results.push({ protocol: protocol.protocol, endpoint, ok, status, latencyMs: Date.now() - started, errorCode, message })
  }
  const healthy = results.some(result => result.ok)
  await useDatabase(event).update(channels).set({ healthStatus: healthy ? 'healthy' : 'unhealthy', lastHealthCheckAt: new Date(), lastHealthError: healthy ? null : results.map(result => `${result.protocol}: ${result.errorCode ? `[${result.errorCode}] ` : ''}${result.message || '检测失败'}`).join('\n').slice(0, 2000), updatedAt: new Date() }).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId)))
  return { healthy, results }
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

export async function deleteUserRelay(event: H3Event, ownerUserId: string, id: string) {
  await ownedRelay(event, ownerUserId, id)
  const [deleted] = await useDatabase(event).delete(channels).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId), eq(channels.ownerKind, 'user'))).returning({ id: channels.id })
  if (!deleted) throw createError({ statusCode: 404, message: '中转不存在' })
  await invalidateChannelAccess(event, [id])
  return { success: true }
}
