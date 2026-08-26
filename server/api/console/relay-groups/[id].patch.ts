import { requireUser } from '../../../services/admin-auth'
import { updateUserRelayGroup } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return updateUserRelayGroup(event, user.userId, getRouterParam(event, 'id') || '', await readBody<Record<string, unknown>>(event) || {})
})
