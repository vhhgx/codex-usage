import { requireAccountAdmin } from '../../../../../services/admin-auth'
import { provisionUserPool } from '../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  return provisionUserPool(event, getRouterParam(event, 'id') || '', admin.userId)
})
