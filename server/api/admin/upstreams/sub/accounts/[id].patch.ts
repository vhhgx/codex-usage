import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { updateManagedSub2ApiAccount } from '../../../../../services/sub2api-admin'
import { accountUpdatePayload } from '../../../../../services/upstream-input'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-account-update', 30, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  const payload = await accountUpdatePayload(event, body)
  const account = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: 'sub.account.update',
    targetType: 'sub2api_account', targetRef: id, fingerprint: { id, payload },
    safeSummary: { fields: Object.keys(payload), groupCount: Array.isArray(payload.group_ids) ? payload.group_ids.length : undefined }
  }, async () => ({ result: await updateManagedSub2ApiAccount(event, id, payload) }))
  await writeAudit(event, admin.userId, 'sub.account.update', 'sub2api_account', id, {
    fields: Object.keys(payload), result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return { account }
})
