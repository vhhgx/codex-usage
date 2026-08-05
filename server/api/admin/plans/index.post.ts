import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { createPlan } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const plan = await createPlan(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'plan.create', 'service_plan', plan.id, { name: plan.name })
    return { plan }
  })
})
