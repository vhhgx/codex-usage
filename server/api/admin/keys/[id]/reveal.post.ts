import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { revealHubKeySecret } from '../../../../services/hub-admin'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-key-reveal:${admin.userId}:${id}`, 10, 60_000)
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
