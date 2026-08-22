import { requireUser } from '../../../../../services/admin-auth'
import { verifyUserPoolAccount } from '../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return verifyUserPoolAccount(event, user.userId, getRouterParam(event, 'id') || '')
})
