import { requireAdmin } from '../../../services/admin-auth'
import { getUserDetail } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return getUserDetail(event, getRouterParam(event, 'id') || '')
})
