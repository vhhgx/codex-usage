import { requireUser } from '../../services/admin-auth'
import { listAnnouncements } from '../../services/customer-management'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  return { announcements: await listAnnouncements(event, true) }
})
