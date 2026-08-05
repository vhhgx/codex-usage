import { requireUser } from '../../services/admin-auth'
import { getUserUsage } from '../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserUsage(event, user.userId)
})
