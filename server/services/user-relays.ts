import { randomUUID } from 'node:crypto'
import { and, count, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { ChannelModelView, ChannelProtocol, ChannelType } from '#shared/types/hub'
import { useDatabase } from '../db'
import { channelModelBindings, channelModels, channelProtocolBindings, channels } from '../db/schema'
import { decryptChannelSecret, encryptChannelSecret } from '../utils/hub-crypto'
import { normalizeUserUpstreamUrl, pinnedUpstreamFetch, resolvePublicUpstream } from '../utils/upstream-url'
import { listChannels, parseChannelModels, parseChannelProtocols, replaceChannelModels, replaceChannelProtocols } from './hub-admin'
import { discoverUpstreamModelIds, mergeDiscoveredModelMappings, syncChannelModelsFromUpstream } from './hub-model-discovery'
import { invalidateChannelAccess } from './channel-access'

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

export async function getUserRelay(event: H3Event, ownerUserId: string, id: string) {
  await ownedRelay(event, ownerUserId, id)
  return (await listUserRelays(event, ownerUserId)).find(channel => channel.id === id)!
}

async function discoverPrivateModels(baseUrl: string, apiKey: string, timeoutMs: number, protocols: ReturnType<typeof parseChannelProtocols>, channelId: string) {
  const preferred = protocols.find(binding => binding.protocol === 'openai_responses')
    || protocols.find(binding => binding.protocol === 'openai_chat')
    || protocols[0]
  if (!preferred) return []
  const ids = await discoverUpstreamModelIds(preferred.baseUrlOverride || baseUrl, apiKey, timeoutMs, {
    authScheme: preferred.authScheme,
    apiVersion: preferred.apiVersion,
    privateUrl: true
  })
  return ids.map(upstreamModel => ({
    publicModel: `relay/${channelId.slice(0, 8)}/${upstreamModel}`.slice(0, 200),
    upstreamModel,
    enabled: true,
    endpoints: [],
    protocolBindings: protocols.map(protocol => ({ protocol: protocol.protocol, upstreamModel, enabled: true, capabilities: { streaming: true, tools: true } }))
  } satisfies ChannelModelView))
}

export async function createUserRelay(event: H3Event, ownerUserId: string, body: Input) {
  const allowed = new Set(['name', 'baseUrl', 'apiKey', 'protocols', 'models', 'enabled', 'priority', 'weight', 'maxConcurrency', 'timeoutMs'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能设置字段：${invalid.join(', ')}` })
  const [existing] = await useDatabase(event).select({ value: count() }).from(channels).where(and(eq(channels.ownerKind, 'user'), eq(channels.ownerUserId, ownerUserId)))
  if (Number(existing?.value || 0) >= MAX_USER_RELAYS) throw createError({ statusCode: 409, message: `每个用户最多添加 ${MAX_USER_RELAYS} 个中转` })
  const name = text(body.name, 120)
  const apiKey = text(body.apiKey, 2000)
  const baseUrl = normalizeUserUpstreamUrl(text(body.baseUrl, 1000))
  if (!name || !apiKey) throw createError({ statusCode: 400, message: '名称、地址和 API Key 均为必填项' })
  await resolvePublicUpstream(baseUrl)
  validateModelCount(body.models)
  const provisionalType: ChannelType = Array.isArray(body.protocols) && body.protocols.some(item => item && typeof item === 'object' && (item as Input).protocol === 'anthropic_messages') ? 'anthropic_compatible' : 'openai_compatible'
  const protocols = await validateUserProtocols(parseChannelProtocols(body.protocols, provisionalType))
  if (!protocols.length) throw createError({ statusCode: 400, message: '请至少选择一种上游协议' })
  const id = randomUUID()
  const timeoutMs = integer(body.timeoutMs, 1000, 600000, 120000)
  let models = parseChannelModels(body.models)
  if (!models.length) {
    try { models = await discoverPrivateModels(baseUrl, apiKey, timeoutMs, protocols, id) } catch {}
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
    priority: integer(body.priority, 0, 10000, 100),
    weight: integer(body.weight, 1, 1000, 1),
    maxConcurrency: integer(body.maxConcurrency, 1, 1000, 5),
    timeoutMs
  }).returning()
  if (!created) throw createError({ statusCode: 500, message: '创建中转失败' })
  const protocolRows = await replaceChannelProtocols(event, id, protocols)
  await replaceChannelModels(event, id, models, protocolRows)
  return getUserRelay(event, ownerUserId, id)
}

export async function updateUserRelay(event: H3Event, ownerUserId: string, id: string, body: Input) {
  const relay = await ownedRelay(event, ownerUserId, id)
  const allowed = new Set(['name', 'baseUrl', 'apiKey', 'protocols', 'models', 'enabled', 'priority', 'weight', 'maxConcurrency', 'timeoutMs'])
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
  if ('priority' in body) patch.priority = integer(body.priority, 0, 10000, relay.priority)
  if ('weight' in body) patch.weight = integer(body.weight, 1, 1000, relay.weight)
  if ('maxConcurrency' in body) patch.maxConcurrency = integer(body.maxConcurrency, 1, 1000, relay.maxConcurrency)
  if ('timeoutMs' in body) patch.timeoutMs = integer(body.timeoutMs, 1000, 600000, relay.timeoutMs)
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

export async function testUserRelay(event: H3Event, ownerUserId: string, id: string) {
  const relay = await ownedRelay(event, ownerUserId, id)
  const protocols = await useDatabase(event).select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, id))
  const apiKey = decryptChannelSecret(relay.encryptedApiKey, relay.id, 'user', event)
  const results = []
  for (const protocol of protocols) {
    const [modelBinding] = await useDatabase(event).select({ upstreamModel: channelModelBindings.upstreamModel })
      .from(channelModelBindings)
      .innerJoin(channelModels, eq(channelModelBindings.channelModelId, channelModels.id))
      .where(and(eq(channelModelBindings.protocolBindingId, protocol.id), eq(channelModelBindings.enabled, true), eq(channelModels.enabled, true)))
      .limit(1)
    const model = modelBinding?.upstreamModel
    if (!model) {
      const message = '该协议没有启用的模型绑定'
      await useDatabase(event).update(channelProtocolBindings).set({ verificationStatus: 'failed', verifiedAt: new Date(), lastError: message, updatedAt: new Date() }).where(and(eq(channelProtocolBindings.id, protocol.id), eq(channelProtocolBindings.channelId, relay.id)))
      results.push({ protocol: protocol.protocol, ok: false, latencyMs: 0, message })
      continue
    }
    const payload = testPayload(protocol.protocol, model)
    let ok = false
    let message: string | null = null
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
      const text = await result.response.text()
      await result.close().catch(() => {})
      ok = result.response.ok
      message = ok ? null : `HTTP ${result.response.status}: ${text.slice(0, 300)}`
    } catch (error) {
      message = error instanceof Error ? error.message.slice(0, 300) : '连接失败'
    }
    await useDatabase(event).update(channelProtocolBindings).set({ verificationStatus: ok ? 'verified' : 'failed', verifiedAt: new Date(), lastError: message, updatedAt: new Date() }).where(and(eq(channelProtocolBindings.id, protocol.id), eq(channelProtocolBindings.channelId, relay.id)))
    results.push({ protocol: protocol.protocol, ok, latencyMs: Date.now() - started, message })
  }
  const healthy = results.some(result => result.ok)
  await useDatabase(event).update(channels).set({ healthStatus: healthy ? 'healthy' : 'unhealthy', lastHealthCheckAt: new Date(), lastHealthError: healthy ? null : results.map(result => result.message).filter(Boolean).join('; ').slice(0, 500), updatedAt: new Date() }).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId)))
  return { healthy, results }
}

export async function syncUserRelayModels(event: H3Event, ownerUserId: string, id: string) {
  await ownedRelay(event, ownerUserId, id)
  const result = await syncChannelModelsFromUpstream(event, id)
  await invalidateChannelAccess(event, [id])
  return result
}

export async function deleteUserRelay(event: H3Event, ownerUserId: string, id: string) {
  await ownedRelay(event, ownerUserId, id)
  const [deleted] = await useDatabase(event).delete(channels).where(and(eq(channels.id, id), eq(channels.ownerUserId, ownerUserId), eq(channels.ownerKind, 'user'))).returning({ id: channels.id })
  if (!deleted) throw createError({ statusCode: 404, message: '中转不存在' })
  await invalidateChannelAccess(event, [id])
  return { success: true }
}
