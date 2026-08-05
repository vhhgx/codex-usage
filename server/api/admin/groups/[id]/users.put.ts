import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { updateGroupRecord } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ userIds?: unknown }>(event) || {}
  const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : []
  return auditedMutation(event, async () => {
    const group = await updateGroupRecord(event, id, { userIds }, admin.userId)
    await writeAudit(event, admin.userId, 'group.members_sync', 'group', id, { userIds })
    return { group }
  })
})
