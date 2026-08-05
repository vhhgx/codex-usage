import { requireUser } from '../../services/admin-auth'
import { getUserPlan } from '../../services/customer-management'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { subscription: await getUserPlan(event, user.userId) }
})
