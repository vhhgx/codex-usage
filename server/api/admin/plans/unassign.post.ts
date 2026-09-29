import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { unassignUserPlan } from '../../../services/customer-management'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<{ userId?: unknown }>(event) || {}
  if (typeof body.userId !== 'string' || !body.userId) throw createError({ statusCode: 400, message: '请选择用户' })
  return auditedMutation(event, async () => {
    const subscription = await unassignUserPlan(event, body.userId as string, admin.userId)
    await writeAudit(event, admin.userId, 'plan.unassign', 'user', body.userId as string, {})
    return { subscription }
  })
})
