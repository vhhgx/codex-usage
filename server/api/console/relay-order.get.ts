import { requireUser } from '../../services/admin-auth'
import { listUserRelayOrder } from '../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { sources: await listUserRelayOrder(event, user.userId) }
})
