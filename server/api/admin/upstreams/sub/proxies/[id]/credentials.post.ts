import { requireAccountAdmin, writeAudit } from '../../../../../../services/admin-auth'
import { getManagedSub2ApiProxyCredentials } from '../../../../../../services/sub2api-admin'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-proxy-credentials:${admin.userId}:${id}`, 10, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await getManagedSub2ApiProxyCredentials(event, id)
    await writeAudit(event, admin.userId, 'sub.proxy.credentials_view', 'sub2api_proxy', id)
    return result
  } catch (error) {
    await writeAudit(event, admin.userId, 'sub.proxy.credentials_view_failed', 'sub2api_proxy', id, { securityEvent: true })
    throw error
  }
})
