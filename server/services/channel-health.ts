import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelProtocolBindings, channels } from '../db/schema'
import { decryptChannelSecret } from '../utils/hub-crypto'
import { pinnedUpstreamFetch, upstreamTarget } from '../utils/upstream-url'
import { isClientIdentityRejection, probeAuthSchemes, upstreamAuthHeaders } from '../utils/upstream-auth'
import { requestUpstreamClientIdentity, upstreamProbeClientIdentity } from '../utils/upstream-client-identity'
import { redactSensitiveText } from '../utils/upstream'
import { recordChannelSuccess } from './hub-routing'

export async function checkChannelHealth(event: H3Event | undefined, channel: typeof channels.$inferSelect) {
  const started = Date.now()
  if (channel.ownerKind === 'user') return { healthy: channel.healthStatus === 'healthy', pending: channel.healthStatus === 'unknown', latencyMs: 0, message: channel.lastHealthError }
  let healthy = false
  let pendingIdentity = false
  let message = ''
  try {
    const db = useDatabase(event)
    const protocols = await db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channel.id))
    // Disabled bindings are an explicit operator choice and must not make a
    // channel look healthy (or mutate auth metadata) during background checks.
    const enabledProtocols = protocols.filter(protocol => protocol.enabled)
    const candidates = enabledProtocols.length
      ? enabledProtocols
      : protocols.length
        ? []
        : [{ id: '', protocol: 'openai_chat' as const, authScheme: 'bearer' as const, apiVersion: null, baseUrlOverride: null }]
    const errors: string[] = []
    if (protocols.length && !enabledProtocols.length) errors.push('没有启用的上游协议')
    const apiKey = decryptChannelSecret(channel.encryptedApiKey, channel.id, channel.ownerKind, event)
    for (const protocol of candidates) {
      const base = protocol.baseUrlOverride || channel.baseUrl
      try {
        const probe = await probeAuthSchemes(protocol.authScheme, async (authScheme) => {
          const forwardedIdentity = channel.clientIdentityMode === 'passthrough' && event
            ? requestUpstreamClientIdentity(event, protocol.protocol)
            : {}
          const request = async (withIdentity: boolean) => {
            const syntheticIdentity = withIdentity && !Object.keys(forwardedIdentity).length
            const headers = {
              ...upstreamAuthHeaders(authScheme, apiKey, protocol.apiVersion),
              ...(withIdentity ? (Object.keys(forwardedIdentity).length ? forwardedIdentity : upstreamProbeClientIdentity(protocol.protocol)) : forwardedIdentity)
            }
            if (channel.ownerKind === 'user') {
              const result = await pinnedUpstreamFetch(base, '/v1/models', { headers, signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000)) })
              const body = await result.response.text()
              const response = { ok: result.response.ok, status: result.response.status, body, identityOnly: syntheticIdentity && result.response.ok }
              await result.close().catch(() => {})
              return response
            }
            const response = await fetch(upstreamTarget(base, '/v1/models'), { headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000)) })
            return { ok: response.ok, status: response.status, body: await response.text(), identityOnly: syntheticIdentity && response.ok }
          }
          let response = await request(false)
          if (!response.ok && isClientIdentityRejection(response.body)) {
            const retry = await request(true)
            if (retry.ok && retry.identityOnly) {
              pendingIdentity = true
              return { ...retry, identityOnly: true }
            }
            response = retry
          }
          return response
        })
        const final = probe.attempts.at(-1)!
        if (!probe.ok) {
          errors.push(`${protocol.protocol}: ${final.identityOnly ? '上游要求兼容客户端身份' : `HTTP ${final.status}: ${redactSensitiveText(final.body).slice(0, 300)}`}`)
          continue
        }
        // A 2xx status alone is not enough: an HTML login page or an
        // unrelated JSON response must not make a channel routable. The
        // model-list shape is the common contract used by the gateway.
        let payload: unknown
        try { payload = JSON.parse(final.body) } catch { throw new Error('/v1/models 未返回有效 JSON') }
        if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data) || !(payload as { data: unknown[] }).data.length) {
          throw new Error('/v1/models 未返回可用模型')
        }
        if (probe.changed && probe.selectedAuthScheme && protocol.id) {
          await db.update(channelProtocolBindings).set({ authScheme: probe.selectedAuthScheme, updatedAt: new Date() }).where(eq(channelProtocolBindings.id, protocol.id))
        }
        healthy = true
      } catch (error) {
        errors.push(`${protocol.protocol}: ${error instanceof Error ? error.message : '无法连接上游'}`)
      }
    }
    message = errors.join('; ').slice(0, 500)
  } catch (error) {
    message = error instanceof Error ? error.message.slice(0, 500) : '无法连接上游'
  }
  await useDatabase(event).update(channels).set({
    healthStatus: healthy ? 'healthy' : pendingIdentity ? 'unknown' : 'unhealthy',
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
