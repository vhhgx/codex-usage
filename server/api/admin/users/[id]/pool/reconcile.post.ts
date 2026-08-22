import { requireAccountAdmin } from '../../../../../services/admin-auth'
import { reconcileUserPool } from '../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  await requireAccountAdmin(event)
  return reconcileUserPool(event, getRouterParam(event, 'id') || '')
})
