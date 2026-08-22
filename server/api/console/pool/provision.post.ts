import { requireUser } from '../../../services/admin-auth'
import { provisionUserPool } from '../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return provisionUserPool(event, user.userId)
})
