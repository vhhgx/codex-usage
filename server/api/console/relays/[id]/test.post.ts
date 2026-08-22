import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { testUserRelay } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const result = await testUserRelay(event, user.userId, id)
  await writeAudit(event, user.userId, 'relay.self_test', 'channel', id, { healthy: result.healthy })
  return result
})
