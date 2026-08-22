import { requireUser } from '../../../../services/admin-auth'
import { startUserPoolOAuth } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return startUserPoolOAuth(event, user.userId)
})
