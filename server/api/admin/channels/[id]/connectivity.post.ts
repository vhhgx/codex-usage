import { eq } from 'drizzle-orm'
import { requireAdmin, writeAudit } from '../../../../services/admin-auth'
import { useDatabase } from '../../../../db'
import { channels } from '../../../../db/schema'
import { probeUpstreamConnectivity } from '../../../../services/upstream-connectivity'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const [channel] = await useDatabase(event).select({ id: channels.id, baseUrl: channels.baseUrl, type: channels.type }).from(channels).where(eq(channels.id, id)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })
  const result = await probeUpstreamConnectivity(channel.baseUrl)
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
