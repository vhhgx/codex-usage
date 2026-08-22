import { requireAccountAdmin } from '../../../../../../services/admin-auth'
import { startUserPoolOAuth } from '../../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  await requireAccountAdmin(event)
  return startUserPoolOAuth(event, getRouterParam(event, 'id') || '')
})
