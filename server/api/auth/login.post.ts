import { login } from '../../services/admin-auth'
import { enforceRateLimit } from '../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, 'login', 8, 15 * 60 * 1000)
  const body = await readBody<{ username?: unknown; password?: unknown }>(event) || {}
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!username || !password) throw createError({ statusCode: 400, message: '请输入用户名和密码' })
  const user = await login(event, username, password)
  return { user, home: user.role === 'user' ? '/console' : '/admin' }
})
