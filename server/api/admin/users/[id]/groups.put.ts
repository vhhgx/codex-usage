import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { syncUserGroups } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ groupIds?: unknown }>(event) || {}
  const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(String) : []
  return auditedMutation(event, async () => {
    const user = await syncUserGroups(event, id, groupIds, admin.userId)
    await writeAudit(event, admin.userId, 'group.members_sync', 'user', id, { groupIds })
    return { user }
  })
})
