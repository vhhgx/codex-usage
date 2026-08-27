import { and, eq, inArray } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelModelBindings, channelModelPrices, channelModels, channelProtocolBindings, channels, modelPools } from '../db/schema'
import { decryptChannelSecret } from '../utils/hub-crypto'
import { pinnedUpstreamFetch, upstreamTarget } from '../utils/upstream-url'
import type { ChannelModelView } from '#shared/types/hub'
import { canonicalModelId, modelRevision, modelVendorFamily } from '#shared/utils/model-routing'
import { alternateAuthScheme, isClientIdentityRejection, upstreamAuthHeaders } from '../utils/upstream-auth'
import { upstreamProbeClientIdentity } from '../utils/upstream-client-identity'

const MAX_DISCOVERED_MODELS = 2000

export function modelIdsFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) return []
  const ids = (payload as { data: unknown[] }).data.flatMap((item) => {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id
        : ''
    const normalized = id.trim().slice(0, 200)
    return normalized ? [normalized] : []
  })
  return [...new Set(ids)].slice(0, MAX_DISCOVERED_MODELS).sort()
}

export interface DiscoveredUpstreamModel {
  id: string
  inputPerMillion: number | null
  outputPerMillion: number | null
  cachedPerMillion: number | null
  reasoningPerMillion: number | null
  currency: string
}

function finitePrice(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function modelsFromPayload(payload: unknown): DiscoveredUpstreamModel[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) return []
  return (payload as { data: unknown[] }).data.flatMap((raw) => {
    const item = typeof raw === 'string' ? { id: raw } : raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    const id = typeof item?.id === 'string' ? item.id.trim().slice(0, 200) : ''
    if (!id) return []
    const pricing = item?.pricing && typeof item.pricing === 'object' ? item.pricing as Record<string, unknown> : item || {}
    return [{
      id,
      inputPerMillion: finitePrice(pricing.input_per_million ?? pricing.prompt_per_million),
      outputPerMillion: finitePrice(pricing.output_per_million ?? pricing.completion_per_million),
      cachedPerMillion: finitePrice(pricing.cached_per_million ?? pricing.cache_read_per_million),
      reasoningPerMillion: finitePrice(pricing.reasoning_per_million),
      currency: typeof pricing.currency === 'string' && pricing.currency.trim() ? pricing.currency.trim().toUpperCase().slice(0, 8) : 'USD'
    }]
  }).filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index).slice(0, MAX_DISCOVERED_MODELS).sort((a, b) => a.id.localeCompare(b.id))
}

export function mergeDiscoveredModelMappings(ids: string[], manual: ChannelModelView[]) {
  const automatic: ChannelModelView[] = ids.map(publicModel => ({
    publicModel,
    upstreamModel: publicModel,
    enabled: true,
    endpoints: []
  }))
  return [...new Map([...automatic, ...manual].map(model => [model.publicModel, model])).values()]
}

export async function discoverUpstreamModelIds(baseUrl: string, apiKey: string, timeoutMs = 15000, options: { authScheme?: 'bearer' | 'x_api_key'; apiVersion?: string | null; privateUrl?: boolean; protocol?: 'anthropic_messages' | 'openai_responses' | 'openai_chat' } = {}) {
  return (await discoverUpstreamModels(baseUrl, apiKey, timeoutMs, options)).map(item => item.id)
}

export async function discoverUpstreamModels(baseUrl: string, apiKey: string, timeoutMs = 15000, options: { authScheme?: 'bearer' | 'x_api_key'; apiVersion?: string | null; privateUrl?: boolean; protocol?: 'anthropic_messages' | 'openai_responses' | 'openai_chat' } = {}) {
  const initialAuth = options.authScheme || (options.protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer')
  const protocol = options.protocol || (initialAuth === 'x_api_key' ? 'anthropic_messages' : 'openai_responses')
  const attempts = [initialAuth, alternateAuthScheme(initialAuth)]
  let lastFailure: { status: number; body: string } | null = null
  for (const authScheme of attempts) {
    for (const withIdentity of [false, true]) {
      if (withIdentity && (!lastFailure || !isClientIdentityRejection(lastFailure.body))) continue
      let response: Response
      let close: (() => Promise<void>) | null = null
      try {
        const headers: Record<string, string> = {
          ...(authScheme === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : upstreamAuthHeaders(authScheme, apiKey, options.apiVersion)),
          ...(withIdentity ? upstreamProbeClientIdentity(protocol) : {})
        }
        if (options.privateUrl) {
          const result = await pinnedUpstreamFetch(baseUrl, '/v1/models', { headers, signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1000), 15000)) })
          response = result.response as unknown as Response
          close = result.close
        } else {
          response = await fetch(upstreamTarget(baseUrl, '/v1/models'), { headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1000), 15000)) })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法连接上游'
        throw createError({ statusCode: 502, message: `读取上游模型失败：${message}` })
      }
      const body = await response.text()
      if (close) await close().catch(() => {})
      if (response.ok) {
        let payload: unknown
        try { payload = JSON.parse(body) } catch { throw createError({ statusCode: 502, message: '读取上游模型失败：/v1/models 未返回有效 JSON' }) }
        const models = modelsFromPayload(payload)
        if (!models.length) throw createError({ statusCode: 502, message: '上游 /v1/models 没有返回任何可用模型' })
        return models
      }
      lastFailure = { status: response.status, body }
      if (!isClientIdentityRejection(body) && response.status !== 401 && response.status !== 403) break
    }
  }
  if (lastFailure) throw createError({ statusCode: 502, message: `读取上游模型失败：HTTP ${lastFailure.status} ${lastFailure.body.slice(0, 300)}`.trim() })
  throw createError({ statusCode: 502, message: '读取上游模型失败：上游未返回响应' })
}

export async function persistDiscoveredModels(event: H3Event | undefined, channelId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)].slice(0, MAX_DISCOVERED_MODELS)
  if (!uniqueIds.length) return { discovered: 0, added: 0 }
  const db = useDatabase(event)
  const added = await db.insert(channelModels).values(uniqueIds.map(id => ({
    channelId,
    publicModel: id,
    upstreamModel: id,
    canonicalModel: canonicalModelId(id),
    vendorFamily: modelVendorFamily(id),
    modelRevision: modelRevision(id),
    mappingKind: 'identity',
    enabled: true,
    endpoints: []
  }))).onConflictDoNothing().returning({ id: channelModels.id })
  await db.insert(modelPools).values(uniqueIds.map(publicModel => ({ publicModel }))).onConflictDoNothing()
  const [models, protocols] = await Promise.all([
    db.select().from(channelModels).where(eq(channelModels.channelId, channelId)),
    db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channelId))
  ])
  const bindings = models.flatMap(model => protocols.map(protocol => ({
    channelModelId: model.id,
    protocolBindingId: protocol.id,
    upstreamModel: model.upstreamModel,
    capabilities: { streaming: true, tools: true },
    enabled: model.enabled && protocol.enabled
  })))
  if (bindings.length) await db.insert(channelModelBindings).values(bindings).onConflictDoNothing()
  return { discovered: uniqueIds.length, added: added.length }
}

export function userDiscoveredModelPlan(
  channelId: string,
  ids: string[],
  existing: Array<{ id: string; publicModel: string; upstreamModel: string; enabled: boolean }>
) {
  const available = new Set(ids)
  const legacyPrefix = `relay/${channelId.slice(0, 8)}/`
  const stale = existing.filter(model => !available.has(model.upstreamModel) || model.publicModel.startsWith(legacyPrefix))
  const direct = existing.filter(model => available.has(model.publicModel) && model.publicModel === model.upstreamModel && !stale.includes(model))
  return {
    staleIds: stale.map(model => model.id),
    reactivatedIds: direct.filter(model => !model.enabled).map(model => model.id)
  }
}

async function reconcileUserDiscoveredModels(event: H3Event, channelId: string, ids: string[]) {
  const db = useDatabase(event)
  const available = new Set(ids)
  const existing = await db.select().from(channelModels).where(eq(channelModels.channelId, channelId))
  const plan = userDiscoveredModelPlan(channelId, ids, existing)
  if (plan.staleIds.length) await db.delete(channelModels).where(inArray(channelModels.id, plan.staleIds))
  const persisted = await persistDiscoveredModels(event, channelId, ids)
  const [models, protocols] = await Promise.all([
    db.select().from(channelModels).where(eq(channelModels.channelId, channelId)),
    db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channelId))
  ])
  const directModels = models.filter(model => available.has(model.publicModel) && model.publicModel === model.upstreamModel)
  const reactivated = plan.reactivatedIds.length
  if (directModels.length) {
    const modelIds = directModels.map(model => model.id)
    await db.update(channelModels).set({ enabled: true, updatedAt: new Date() }).where(inArray(channelModels.id, modelIds))
    const enabledProtocols = protocols.filter(protocol => protocol.enabled).map(protocol => protocol.id)
    const disabledProtocols = protocols.filter(protocol => !protocol.enabled).map(protocol => protocol.id)
    if (enabledProtocols.length) await db.update(channelModelBindings).set({ enabled: true, updatedAt: new Date() }).where(and(
      inArray(channelModelBindings.channelModelId, modelIds),
      inArray(channelModelBindings.protocolBindingId, enabledProtocols)
    ))
    if (disabledProtocols.length) await db.update(channelModelBindings).set({ enabled: false, updatedAt: new Date() }).where(and(
      inArray(channelModelBindings.channelModelId, modelIds),
      inArray(channelModelBindings.protocolBindingId, disabledProtocols)
    ))
  }
  return { ...persisted, removed: plan.staleIds.length, reactivated }
}

export async function syncChannelModelsFromUpstream(event: H3Event, channelId: string) {
  const db = useDatabase(event)
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })
  const protocols = await db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channelId))
  const protocol = protocols.find(binding => binding.protocol === 'openai_responses')
    || protocols.find(binding => binding.protocol === 'openai_chat')
    || protocols[0]
  const discoveredModels = await discoverUpstreamModels(
    protocol?.baseUrlOverride || channel.baseUrl,
    decryptChannelSecret(channel.encryptedApiKey, channel.id, channel.ownerKind, event),
    channel.timeoutMs,
    { authScheme: protocol?.authScheme, apiVersion: protocol?.apiVersion, privateUrl: channel.ownerKind === 'user', protocol: protocol?.protocol }
  )
  const ids = discoveredModels.map(item => item.id)
  const persisted = channel.ownerKind === 'user'
    ? await reconcileUserDiscoveredModels(event, channel.id, ids)
    : { ...(await persistDiscoveredModels(event, channel.id, ids)), removed: 0, reactivated: 0 }
  if (channel.ownerKind === 'user') {
    await db.update(channelProtocolBindings).set({ verificationStatus: 'unknown', verifiedAt: null, lastError: null, updatedAt: new Date() }).where(eq(channelProtocolBindings.channelId, channel.id))
  }
  const persistedModels = await db.select().from(channelModels).where(eq(channelModels.channelId, channel.id))
  for (const discovered of discoveredModels) {
    const model = persistedModels.find(item => item.upstreamModel === discovered.id && item.publicModel === discovered.id)
    if (!model || discovered.inputPerMillion === null && discovered.outputPerMillion === null && discovered.cachedPerMillion === null && discovered.reasoningPerMillion === null) continue
    await db.insert(channelModelPrices).values({
      channelModelId: model.id,
      inputPerMillion: discovered.inputPerMillion === null ? null : String(discovered.inputPerMillion),
      outputPerMillion: discovered.outputPerMillion === null ? null : String(discovered.outputPerMillion),
      cachedPerMillion: discovered.cachedPerMillion === null ? null : String(discovered.cachedPerMillion),
      reasoningPerMillion: discovered.reasoningPerMillion === null ? null : String(discovered.reasoningPerMillion),
      currency: discovered.currency,
      source: 'upstream_models',
      fetchedAt: new Date(),
      updatedAt: new Date()
    }).onConflictDoUpdate({ target: channelModelPrices.channelModelId, set: {
      inputPerMillion: discovered.inputPerMillion === null ? null : String(discovered.inputPerMillion), outputPerMillion: discovered.outputPerMillion === null ? null : String(discovered.outputPerMillion),
      cachedPerMillion: discovered.cachedPerMillion === null ? null : String(discovered.cachedPerMillion), reasoningPerMillion: discovered.reasoningPerMillion === null ? null : String(discovered.reasoningPerMillion),
      currency: discovered.currency, source: 'upstream_models', fetchedAt: new Date(), updatedAt: new Date()
    } })
  }
  return { ...persisted, models: ids }
}
