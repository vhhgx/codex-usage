import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { revealUserKey } from '../../../../services/user-console'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `user-key-reveal:${user.userId}:${id}`, 10, 60_000)
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
