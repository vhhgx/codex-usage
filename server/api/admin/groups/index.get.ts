import { requireAdmin } from '../../../services/admin-auth'
import { listGroups } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { groups: await listGroups(event) }
})
