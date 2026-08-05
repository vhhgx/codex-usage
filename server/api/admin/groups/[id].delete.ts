import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { deleteGroupRecord } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await deleteGroupRecord(event, id)
    await writeAudit(event, admin.userId, 'group.delete', 'group', id)
    return result
  })
})
