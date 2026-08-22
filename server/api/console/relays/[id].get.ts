import { requireUser } from '../../../services/admin-auth'
import { getUserRelay } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserRelay(event, user.userId, getRouterParam(event, 'id') || '')
})
