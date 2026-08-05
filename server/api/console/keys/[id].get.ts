import { requireUser } from '../../../services/admin-auth'
import { getUserKey } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { key: await getUserKey(event, user.userId, getRouterParam(event, 'id') || '') }
})
