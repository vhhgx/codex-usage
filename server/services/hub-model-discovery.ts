import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelModelBindings, channelModels, channelProtocolBindings, channels, modelPools } from '../db/schema'
import { decryptChannelSecret } from '../utils/hub-crypto'
import { pinnedUpstreamFetch } from '../utils/upstream-url'
import type { ChannelModelView } from '#shared/types/hub'

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

export function mergeDiscoveredModelMappings(ids: string[], manual: ChannelModelView[]) {
  const automatic: ChannelModelView[] = ids.map(publicModel => ({
    publicModel,
    upstreamModel: publicModel,
    enabled: true,
    endpoints: []
  }))
  return [...new Map([...automatic, ...manual].map(model => [model.publicModel, model])).values()]
}

function upstreamBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

export async function discoverUpstreamModelIds(baseUrl: string, apiKey: string, timeoutMs = 15000, options: { authScheme?: 'bearer' | 'x_api_key'; apiVersion?: string | null; privateUrl?: boolean } = {}) {
  let response: Response
  let close: (() => Promise<void>) | null = null
  try {
    const headers: Record<string, string> = options.authScheme === 'x_api_key'
      ? { 'x-api-key': apiKey, 'anthropic-version': options.apiVersion || '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` }
    if (options.privateUrl) {
      const result = await pinnedUpstreamFetch(baseUrl, '/v1/models', { headers, signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1000), 15000)) })
      response = result.response as unknown as Response
      close = result.close
    } else {
      response = await fetch(`${upstreamBaseUrl(baseUrl)}/v1/models`, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1000), 15000))
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法连接上游'
    throw createError({ statusCode: 502, message: `读取上游模型失败：${message}` })
  }
  const body = await response.text()
  if (close) await close().catch(() => {})
  if (!response.ok) {
    throw createError({ statusCode: 502, message: `读取上游模型失败：HTTP ${response.status} ${body.slice(0, 300)}`.trim() })
  }
  let payload: unknown
  try { payload = JSON.parse(body) } catch {
    throw createError({ statusCode: 502, message: '读取上游模型失败：/v1/models 未返回有效 JSON' })
  }
  const ids = modelIdsFromPayload(payload)
  if (!ids.length) throw createError({ statusCode: 502, message: '上游 /v1/models 没有返回任何可用模型' })
  return ids
}

export async function persistDiscoveredModels(event: H3Event | undefined, channelId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)].slice(0, MAX_DISCOVERED_MODELS)
  if (!uniqueIds.length) return { discovered: 0, added: 0 }
  const db = useDatabase(event)
  const added = await db.insert(channelModels).values(uniqueIds.map(id => ({
    channelId,
    publicModel: id,
    upstreamModel: id,
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

export async function syncChannelModelsFromUpstream(event: H3Event, channelId: string) {
  const db = useDatabase(event)
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })
  const [protocol] = await db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channelId)).limit(1)
  const ids = await discoverUpstreamModelIds(
    protocol?.baseUrlOverride || channel.baseUrl,
    decryptChannelSecret(channel.encryptedApiKey, channel.id, channel.ownerKind, event),
    channel.timeoutMs,
    { authScheme: protocol?.authScheme, apiVersion: protocol?.apiVersion, privateUrl: channel.ownerKind === 'user' }
  )
  return { ...(await persistDiscoveredModels(event, channel.id, ids)), models: ids }
}
