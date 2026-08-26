import { requireUser } from '../../../../services/admin-auth'
import { reorderUserRelayAccounts } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ orderedIds?: unknown }>(event) || {}
  return reorderUserRelayAccounts(event, user.userId, getRouterParam(event, 'id') || '', body.orderedIds)
})
