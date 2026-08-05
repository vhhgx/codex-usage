import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { deletePlan } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await deletePlan(event, id)
    await writeAudit(event, admin.userId, 'plan.delete', 'service_plan', id)
    return result
  })
})
