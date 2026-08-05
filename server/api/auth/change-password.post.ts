import { changeOwnPassword, requireAuthenticated } from '../../services/admin-auth'

export default defineEventHandler(async (event) => {
  await requireAuthenticated(event)
  const body = await readBody<{ currentPassword?: unknown; newPassword?: unknown }>(event) || {}
  if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') throw createError({ statusCode: 400, message: '请输入当前密码和新密码' })
  await changeOwnPassword(event, body.currentPassword, body.newPassword)
  return { success: true }
})
