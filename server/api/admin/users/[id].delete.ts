import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { deleteUserRecord } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  if (id === admin.userId) throw createError({ statusCode: 409, message: '不能删除当前登录用户' })
  return auditedMutation(event, async () => {
    const result = await deleteUserRecord(event, id)
    await writeAudit(event, admin.userId, 'user.delete', 'user', id)
    return result
  })
})
