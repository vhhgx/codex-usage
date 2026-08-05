import { requireUser } from '../../services/admin-auth'
import { getUserGroups } from '../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { groups: await getUserGroups(event, user.userId) }
})
