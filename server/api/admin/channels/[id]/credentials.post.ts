import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { getPlatformChannelCredentials } from '../../../../services/hub-admin'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-channel-credentials:${admin.userId}:${id}`, 10, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await getPlatformChannelCredentials(event, id)
    await writeAudit(event, admin.userId, 'channel.credentials_view', 'channel', id)
    return result
  } catch (error) {
    await writeAudit(event, admin.userId, 'channel.credentials_view_failed', 'channel', id, { securityEvent: true })
    throw error
  }
})
