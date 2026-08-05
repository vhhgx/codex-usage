import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelModels, channels, modelPools } from '../db/schema'
import { decryptSecret } from '../utils/hub-crypto'
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

export async function discoverUpstreamModelIds(baseUrl: string, apiKey: string, timeoutMs = 15000) {
  let response: Response
  try {
    response = await fetch(`${upstreamBaseUrl(baseUrl)}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1000), 15000))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法连接上游'
    throw createError({ statusCode: 502, message: `读取上游模型失败：${message}` })
  }
  const body = await response.text()
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
  return { discovered: uniqueIds.length, added: added.length }
}

export async function syncChannelModelsFromUpstream(event: H3Event, channelId: string) {
  const db = useDatabase(event)
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })
  const ids = await discoverUpstreamModelIds(channel.baseUrl, decryptSecret(channel.encryptedApiKey, event), channel.timeoutMs)
  return { ...(await persistDiscoveredModels(event, channel.id, ids)), models: ids }
}
