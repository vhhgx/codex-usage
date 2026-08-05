import { requireAdmin } from '../../../services/admin-auth'
import { getGroup } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { group: await getGroup(event, getRouterParam(event, 'id') || '') }
})
