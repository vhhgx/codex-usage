import { requireUser } from '../../../services/admin-auth'
import { getUserPoolUsage } from '../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserPoolUsage(event, user.userId)
})
