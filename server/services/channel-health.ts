import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelProtocolBindings, channels } from '../db/schema'
import { decryptChannelSecret } from '../utils/hub-crypto'
import { pinnedUpstreamFetch } from '../utils/upstream-url'
import { recordChannelSuccess } from './hub-routing'
import { modelIdsFromPayload, persistDiscoveredModels } from './hub-model-discovery'

export async function checkChannelHealth(event: H3Event | undefined, channel: typeof channels.$inferSelect) {
  const started = Date.now()
  let healthy = false
  let message = ''
  try {
    const db = useDatabase(event)
    const protocols = await db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channel.id))
    const candidates = protocols.length ? protocols : [{ id: '', protocol: 'openai_chat' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null }]
    const errors: string[] = []
    const apiKey = decryptChannelSecret(channel.encryptedApiKey, channel.id, channel.ownerKind, event)
    for (const protocol of candidates) {
      const base = (protocol.baseUrlOverride || channel.baseUrl).replace(/\/+$/, '').replace(/\/v1$/i, '')
      const headers: Record<string, string> = protocol.authScheme === 'x_api_key'
        ? { 'x-api-key': apiKey, 'anthropic-version': protocol.apiVersion || '2023-06-01' }
        : { authorization: `Bearer ${apiKey}` }
      let response: Response
      let close: (() => Promise<void>) | null = null
      try {
        if (channel.ownerKind === 'user') {
          const result = await pinnedUpstreamFetch(base, '/v1/models', { headers, signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000)) })
          response = result.response as unknown as Response
          close = result.close
        } else response = await fetch(`${base}/v1/models`, { headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000)) })
        const body = await response.text()
        if (close) await close().catch(() => {})
        if (!response.ok) {
          errors.push(`${protocol.protocol}: HTTP ${response.status}: ${body.slice(0, 300)}`)
          continue
        }
        healthy = true
        let payload: unknown
        try { payload = JSON.parse(body) } catch { payload = null }
        const ids = modelIdsFromPayload(payload)
        if (ids.length) await persistDiscoveredModels(event, channel.id, ids)
      } catch (error) {
        if (close) await close().catch(() => {})
        errors.push(`${protocol.protocol}: ${error instanceof Error ? error.message : '无法连接上游'}`)
      }
    }
    message = healthy ? '' : errors.join('; ').slice(0, 500)
  } catch (error) {
    message = error instanceof Error ? error.message.slice(0, 500) : '无法连接上游'
  }
  await useDatabase(event).update(channels).set({
    healthStatus: healthy ? 'healthy' : 'unhealthy',
    lastHealthCheckAt: new Date(),
    lastHealthError: message || null,
    updatedAt: new Date()
  }).where(eq(channels.id, channel.id))
  if (healthy) await recordChannelSuccess(event, channel.id)
  return { healthy, latencyMs: Date.now() - started, message: message || null }
}

export async function checkAllChannels() {
  const db = useDatabase()
  const rows = await db.select().from(channels).where(eq(channels.enabled, true))
  const queue = [...rows]
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const channel = queue.shift()
      if (channel) await checkChannelHealth(undefined, channel)
    }
  })
  await Promise.all(workers)
}
