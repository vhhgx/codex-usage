import { requireUser } from '../../../../services/admin-auth'
import { removeUserPoolAccount } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return removeUserPoolAccount(event, user.userId, getRouterParam(event, 'id') || '')
})
