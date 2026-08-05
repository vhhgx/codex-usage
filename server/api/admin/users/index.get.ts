import { requireAdmin } from '../../../services/admin-auth'
import { listUsers } from '../../../services/access-control'
import { listPlanAssignments } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const [users, assignments] = await Promise.all([listUsers(event), listPlanAssignments(event)])
  const subscriptions = new Map(assignments.map(item => [item.userId, item.subscription]))
  return { users: users.map(user => ({ ...user, subscription: subscriptions.get(user.id) || null })) }
})
