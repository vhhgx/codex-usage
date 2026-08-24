import { requireUser } from '../../../../services/admin-auth'
import { getUserRelayBalance } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserRelayBalance(event, user.userId, getRouterParam(event, 'id') || '')
})
