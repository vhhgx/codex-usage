import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { createManagedSub2ApiGroup } from '../../../../../services/sub2api-admin'
import { groupPayload } from '../../../../../services/upstream-input'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-group-create', 15, 60_000)
  const payload = await groupPayload(event, await readBody<Record<string, unknown>>(event) || {}, true)
  const group = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'sub2api', action: 'sub.group.create',
    targetType: 'sub2api_group', targetRef: String(payload.name), fingerprint: payload,
    safeSummary: { name: payload.name, platform: payload.platform }
  }, async () => ({ result: await createManagedSub2ApiGroup(event, payload) }))
  await writeAudit(event, admin.userId, 'sub.group.create', 'sub2api_group', group.id, {
    name: group.name, platform: group.platform, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return { group }
})
