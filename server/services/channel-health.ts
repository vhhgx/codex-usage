import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channels } from '../db/schema'
import { decryptSecret } from '../utils/hub-crypto'
import { recordChannelSuccess } from './hub-routing'
import { modelIdsFromPayload, persistDiscoveredModels } from './hub-model-discovery'

export async function checkChannelHealth(event: H3Event | undefined, channel: typeof channels.$inferSelect) {
  const started = Date.now()
  let healthy = false
  let message = ''
  try {
    const base = channel.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
    const response = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${decryptSecret(channel.encryptedApiKey, event)}` },
      signal: AbortSignal.timeout(Math.min(channel.timeoutMs, 15000))
    })
    healthy = response.ok
    const body = await response.text()
    message = response.ok ? '' : `HTTP ${response.status}: ${body.slice(0, 500)}`
    if (response.ok && channel.type === 'sub2api') {
      let payload: unknown
      try { payload = JSON.parse(body) } catch { payload = null }
      const ids = modelIdsFromPayload(payload)
      if (ids.length) await persistDiscoveredModels(event, channel.id, ids)
    }
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
