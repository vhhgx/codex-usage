import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { testUserRelayConnectivity } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const result = await testUserRelayConnectivity(event, user.userId, id)
  await writeAudit(event, user.userId, 'relay.connectivity_test', 'channel', id, {
    success: result.success,
    httpStatus: result.httpStatus,
    responseTimeMs: result.responseTimeMs,
    retryCount: result.retryCount,
    errorCode: result.errorCode
  })
  return result
})
