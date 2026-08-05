import { auditedMutation, requireAdminWrite, writeAudit } from '../../../services/admin-auth'
import { createAnnouncement } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const announcement = await createAnnouncement(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'announcement.create', 'announcement', announcement.id, { status: announcement.status })
    return { announcement }
  })
})
