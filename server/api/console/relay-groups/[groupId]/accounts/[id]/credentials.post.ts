import { requireUser, writeAudit } from '../../../../../../services/admin-auth'
import { getUserRelayCredentials } from '../../../../../../services/user-relays'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `user-relay-credentials:${user.userId}:${id}`, 10, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await getUserRelayCredentials(event, user.userId, id)
    await writeAudit(event, user.userId, 'user_relay.credentials_view', 'channel', id)
    return result
  } catch (error) {
    await writeAudit(event, user.userId, 'user_relay.credentials_view_failed', 'channel', id, { securityEvent: true })
    throw error
  }
})
