import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { deleteManagedSub2ApiAccount, resolveManagedSub2ApiAccount } from '../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-account-delete', 10, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const target = await resolveManagedSub2ApiAccount(event, id)
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: 'sub.account.delete',
    targetType: 'sub2api_account', targetRef: id, fingerprint: { id, name: target.view.name },
    idempotencyFallback: getHeader(event, 'idempotency-key') || null,
    safeSummary: { name: target.view.name, platform: target.view.platform }
  }, async () => ({ result: await deleteManagedSub2ApiAccount(event, id) }))
  await writeAudit(event, admin.userId, 'sub.account.delete', 'sub2api_account', id, {
    name: target.view.name, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
