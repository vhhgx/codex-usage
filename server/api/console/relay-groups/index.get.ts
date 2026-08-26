import { requireUser } from '../../../services/admin-auth'
import { listUserRelayGroups } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { groups: await listUserRelayGroups(event, user.userId) }
})
