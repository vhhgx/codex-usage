import { requireAdmin } from '../../../services/admin-auth'
import { listAnnouncements } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { announcements: await listAnnouncements(event) }
})
