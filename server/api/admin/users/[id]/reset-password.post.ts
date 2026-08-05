import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { resetUserPassword } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  if (id === admin.userId) {
    throw createError({ statusCode: 409, message: '不能在用户管理中重置当前账号密码，请使用修改密码页面' })
  }
  const body = await readBody<{ password?: unknown }>(event) || {}
  const password = typeof body.password === 'string' ? body.password : ''
  return auditedMutation(event, async () => {
    const result = await resetUserPassword(event, id, password)
    await writeAudit(event, admin.userId, 'user.password_reset', 'user', id)
    return result
  })
})
