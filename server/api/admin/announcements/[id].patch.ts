import { auditedMutation, requireAdminWrite, writeAudit } from '../../../services/admin-auth'
import { updateAnnouncement } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const announcement = await updateAnnouncement(event, id, body)
    await writeAudit(event, admin.userId, 'announcement.update', 'announcement', id, { status: announcement.status })
    return { announcement }
  })
})
