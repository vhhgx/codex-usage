import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { resetUserPassword } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ password?: unknown }>(event) || {}
  const password = typeof body.password === 'string' ? body.password : ''
  return auditedMutation(event, async () => {
    const result = await resetUserPassword(event, id, password)
    await writeAudit(event, admin.userId, 'user.password_reset', 'user', id)
    return result
  })
})
