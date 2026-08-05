import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { deleteManagedSub2ApiGroup, resolveManagedSub2ApiGroup } from '../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-group-delete', 10, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const target = await resolveManagedSub2ApiGroup(event, id)
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: 'sub.group.delete',
    targetType: 'sub2api_group', targetRef: id, fingerprint: { id, name: target.view.name },
    idempotencyFallback: getHeader(event, 'idempotency-key') || null,
    safeSummary: { name: target.view.name }
  }, async () => ({ result: await deleteManagedSub2ApiGroup(event, id) }))
  await writeAudit(event, admin.userId, 'sub.group.delete', 'sub2api_group', id, {
    name: target.view.name, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
