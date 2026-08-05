import { requireUser } from '../../services/admin-auth'
import { getUserOverview } from '../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserOverview(event, user.userId)
})
