import { requireUser } from '../../../services/admin-auth'
import { updateUserPool } from '../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return updateUserPool(event, user.userId, await readBody<Record<string, unknown>>(event) || {})
})
