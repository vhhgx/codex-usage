import { requireAdmin } from '../../../services/admin-auth'
import { listPlans } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { plans: await listPlans(event) }
})
