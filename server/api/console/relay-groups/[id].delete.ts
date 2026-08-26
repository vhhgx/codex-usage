import { requireUser } from '../../../services/admin-auth'
import { deleteUserRelayGroup } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body: { deleteAccounts?: boolean } = await readBody<{ deleteAccounts?: boolean }>(event).catch(() => ({}))
  return deleteUserRelayGroup(event, user.userId, getRouterParam(event, 'id') || '', body.deleteAccounts === true)
})
