import { requireUser } from '../../services/admin-auth'
import { getUserModels } from '../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { models: await getUserModels(event, user.userId) }
})
