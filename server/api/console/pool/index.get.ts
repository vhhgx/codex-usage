import { requireUser } from '../../../services/admin-auth'
import { getUserPool } from '../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserPool(event, user.userId)
})
