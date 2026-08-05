import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { assignPlan } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<{ userId?: unknown; planId?: unknown; startsAt?: unknown }>(event) || {}
  if (typeof body.userId !== 'string' || typeof body.planId !== 'string') throw createError({ statusCode: 400, message: '请选择用户和套餐' })
  return auditedMutation(event, async () => {
    const subscription = await assignPlan(event, body.userId as string, body.planId as string, body.startsAt, admin.userId)
    await writeAudit(event, admin.userId, 'plan.assign', 'user', body.userId as string, { planId: body.planId })
    return { subscription }
  })
})
