import { requireUser } from '../../../services/admin-auth'
import { refreshAllUserRelayBalances } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return refreshAllUserRelayBalances(event, user.userId)
})
