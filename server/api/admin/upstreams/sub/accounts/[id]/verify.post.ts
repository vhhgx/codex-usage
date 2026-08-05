import { requireAdmin, writeAudit } from '../../../../../../services/admin-auth'
import { verifyManagedSub2ApiAccount } from '../../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-account-verify', 20, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ activate?: unknown }>(event) || {}
  const activate = body.activate === true
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: activate ? 'sub.account.verify-activate' : 'sub.account.verify',
    targetType: 'sub2api_account', targetRef: id, fingerprint: { id, activate }, safeSummary: { activate }
  }, async () => ({ result: await verifyManagedSub2ApiAccount(event, id, activate) }))
  await writeAudit(event, admin.userId, activate ? 'sub.account.verify-activate' : 'sub.account.verify', 'sub2api_account', id, {
    ...result, requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
