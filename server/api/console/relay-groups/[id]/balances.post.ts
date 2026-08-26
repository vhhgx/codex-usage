import { requireUser } from '../../../../services/admin-auth'
import { refreshUserRelayGroupBalances } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return refreshUserRelayGroupBalances(event, user.userId, getRouterParam(event, 'id') || '')
})
