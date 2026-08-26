import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelProtocolBindings, channels } from '../db/schema'
import { decryptChannelSecret } from '../utils/hub-crypto'
import { pinnedUpstreamFetch } from '../utils/upstream-url'
import { probeAuthSchemes, upstreamAuthHeaders } from '../utils/upstream-auth'
import { recordChannelSuccess } from './hub-routing'

export async function checkChannelHealth(event: H3Event | undefined, channel: typeof channels.$inferSelect) {
  const started = Date.now()
  if (channel.ownerKind === 'user') return { healthy: channel.healthStatus === 'healthy', pending: channel.healthStatus === 'unknown', latencyMs: 0, message: channel.lastHealthError }
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
      try {
        const probe = await probeAuthSchemes(protocol.authScheme, async (authScheme) => {
          const headers = upstreamAuthHeaders(authScheme, apiKey, protocol.apiVersion)
          if (channel.ownerKind === 'user') {
            const result = await pinnedUpstreamFetch(base, '/v1/models', { headers, signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000)) })
            const body = await result.response.text()
            const response = { ok: result.response.ok, status: result.response.status, body }
            await result.close().catch(() => {})
            return response
          }
          const response = await fetch(`${base}/v1/models`, { headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000)) })
          return { ok: response.ok, status: response.status, body: await response.text() }
        })
        const final = probe.attempts.at(-1)!
        if (!probe.ok) {
          errors.push(`${protocol.protocol}: HTTP ${final.status}: ${final.body.slice(0, 300)}`)
          continue
        }
        if (probe.changed && probe.selectedAuthScheme && protocol.id) {
          await db.update(channelProtocolBindings).set({ authScheme: probe.selectedAuthScheme, updatedAt: new Date() }).where(eq(channelProtocolBindings.id, protocol.id))
        }
        healthy = true
      } catch (error) {
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
