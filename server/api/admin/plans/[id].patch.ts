import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { updatePlan } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const plan = await updatePlan(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, 'plan.update', 'service_plan', id)
    return { plan }
  })
})
