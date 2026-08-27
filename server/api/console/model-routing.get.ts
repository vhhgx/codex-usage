import { requireUser } from '../../services/admin-auth'
import { listUserModelRouting } from '../../services/user-model-routing'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return listUserModelRouting(event, user.userId)
})
