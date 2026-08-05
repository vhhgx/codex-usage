import { reauthenticate, requireUser, writeAudit } from '../../../../services/admin-auth'
import { revealUserKey } from '../../../../services/user-console'
import { enforceRateLimit } from '../../../../utils/rate-limit'

const REAUTH_WINDOW_MS = 10 * 60 * 1000

export default defineEventHandler(async (event) => {
  let user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `user-key-reveal:${user.userId}:${id}`, 10, 60_000)
  const body = await readBody<{ password?: unknown }>(event) || {}
  if (Date.now() - user.reauthenticatedAt > REAUTH_WINDOW_MS) {
    if (typeof body.password !== 'string' || !body.password) throw createError({ statusCode: 401, message: '查看完整 Key 前需要重新输入密码' })
    user = await reauthenticate(event, body.password)
  }
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await revealUserKey(event, user.userId, id)
    await writeAudit(event, user.userId, 'key.reveal', 'hub_key', id)
    return result
  } catch (error) {
    await writeAudit(event, user.userId, 'key.reveal_failed', 'hub_key', id, { securityEvent: true })
    throw error
  }
})
