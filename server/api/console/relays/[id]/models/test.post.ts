import { requireUser, writeAudit } from '../../../../../services/admin-auth'
import { testUserRelayModel } from '../../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ model?: unknown }>(event) || {}
  const result = await testUserRelayModel(event, user.userId, id, body.model)
  await writeAudit(event, user.userId, 'relay.model_test', 'channel', id, { model: body.model, healthy: result.healthy })
  return result
})
