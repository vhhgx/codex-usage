import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { groupPayload } from '../../../../../services/upstream-input'
import { updateManagedSub2ApiGroup } from '../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-group-update', 20, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const payload = await groupPayload(event, await readBody<Record<string, unknown>>(event) || {}, false)
  const group = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: 'sub.group.update',
    targetType: 'sub2api_group', targetRef: id, fingerprint: { id, payload }, safeSummary: { fields: Object.keys(payload) }
  }, async () => ({ result: await updateManagedSub2ApiGroup(event, id, payload) }))
  await writeAudit(event, admin.userId, 'sub.group.update', 'sub2api_group', id, {
    fields: Object.keys(payload), result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return { group }
})
