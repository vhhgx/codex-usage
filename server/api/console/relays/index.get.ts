import { requireUser } from '../../../services/admin-auth'
import { listUserRelays } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { relays: await listUserRelays(event, user.userId) }
})
