import { requireUser } from '../../../services/admin-auth'
import { getUserLog } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getUserLog(event, user.userId, getRouterParam(event, 'id') || '')
})
