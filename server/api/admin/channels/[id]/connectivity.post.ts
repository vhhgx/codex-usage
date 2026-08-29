import { eq } from 'drizzle-orm'
import { requireAdmin, writeAudit } from '../../../../services/admin-auth'
import { useDatabase } from '../../../../db'
import { channels } from '../../../../db/schema'
import { probeUpstreamConnectivity } from '../../../../services/upstream-connectivity'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const [channel] = await useDatabase(event).select({ id: channels.id, baseUrl: channels.baseUrl, type: channels.type, ownerKind: channels.ownerKind }).from(channels).where(eq(channels.id, id)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })
  // Only administrator-owned CPA/Sub2API integrations may target an
  // explicitly private WireGuard address. Generic channels remain behind the
  // public-address SSRF guard, even when an administrator invokes the probe.
  const allowPrivateNetwork = channel.ownerKind === 'platform' && (channel.type === 'cpa' || channel.type === 'sub2api')
  const result = await probeUpstreamConnectivity(channel.baseUrl, { allowPrivateNetwork })
  await writeAudit(event, admin.userId, 'channel.connectivity_test', 'channel', id, {
    channelType: channel.type,
    success: result.success,
    httpStatus: result.httpStatus,
    responseTimeMs: result.responseTimeMs,
    retryCount: result.retryCount,
    errorCode: result.errorCode
  })
  return result
})
