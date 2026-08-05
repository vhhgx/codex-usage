import { auditedMutation, requireAdminWrite, writeAudit } from '../../../services/admin-auth'
import { deleteAnnouncement } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await deleteAnnouncement(event, id)
    await writeAudit(event, admin.userId, 'announcement.delete', 'announcement', id)
    return result
  })
})
