import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { deleteManagedSub2ApiProxy, resolveManagedSub2ApiProxy } from '../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-proxy-delete', 10, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const target = await resolveManagedSub2ApiProxy(event, id)
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId,
    connectionId: 'sub2api',
    action: 'sub.proxy.delete',
    targetType: 'sub2api_proxy',
    targetRef: id,
    fingerprint: { id, name: target.view.name },
    idempotencyFallback: getHeader(event, 'idempotency-key') || null,
    safeSummary: { name: target.view.name, host: target.view.host, port: target.view.port }
  }, async () => ({ result: await deleteManagedSub2ApiProxy(event, id) }))
  await writeAudit(event, admin.userId, 'sub.proxy.delete', 'sub2api_proxy', id, {
    name: target.view.name,
    result: 'succeeded',
    requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
