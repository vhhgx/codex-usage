import { requireUser } from '../../../services/admin-auth'
import { listUserKeys } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { keys: await listUserKeys(event, user.userId) }
})
