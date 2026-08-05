import { reauthenticate } from '../../services/admin-auth'
import { enforceRateLimit } from '../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, 'session-reauthenticate', 8, 15 * 60 * 1000)
  const body = await readBody<{ password?: unknown }>(event) || {}
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password) throw createError({ statusCode: 400, message: '请输入当前密码' })
  const session = await reauthenticate(event, password)
  return { reauthenticatedAt: session.reauthenticatedAt }
})
