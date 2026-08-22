import { requireUser } from '../../services/admin-auth'
import { getUserWallet } from '../../services/user-wallet'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserWallet(event, user.userId)
})
