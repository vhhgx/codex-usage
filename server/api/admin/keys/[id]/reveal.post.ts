import { requireAccountAdmin, reauthenticate, writeAudit } from '../../../../services/admin-auth'
import { revealHubKeySecret } from '../../../../services/hub-admin'
import { enforceRateLimit } from '../../../../utils/rate-limit'

const REAUTH_WINDOW_MS = 10 * 60 * 1000

export default defineEventHandler(async (event) => {
  let admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-key-reveal:${admin.userId}:${id}`, 10, 60_000)
  const body = await readBody<{ password?: unknown }>(event) || {}
  if (Date.now() - admin.reauthenticatedAt > REAUTH_WINDOW_MS) {
    if (typeof body.password !== 'string' || !body.password) throw createError({ statusCode: 401, message: '查看完整 Key 前需要重新输入密码' })
    admin = await reauthenticate(event, body.password)
  }
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await revealHubKeySecret(event, id)
    await writeAudit(event, admin.userId, 'key.reveal', 'hub_key', id)
    return result
  } catch (error) {
    await writeAudit(event, admin.userId, 'key.reveal_failed', 'hub_key', id, { securityEvent: true })
    throw error
  }
})
