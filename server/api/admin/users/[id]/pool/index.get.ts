import { requireAdmin } from '../../../../../services/admin-auth'
import { getUserPool } from '../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return getUserPool(event, getRouterParam(event, 'id') || '')
})
