import { requireUser } from '../../../services/admin-auth'
import { createUserRelay } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return createUserRelay(event, user.userId, await readBody<Record<string, unknown>>(event) || {})
})
