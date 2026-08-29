import { requireUser, writeAudit } from '../../../../../services/admin-auth'
import { syncUserRelayModels } from '../../../../../services/user-relays'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `user-relay-model-sync:${user.userId}:${id}`, 5, 60_000)
  const result = await syncUserRelayModels(event, user.userId, id)
  await writeAudit(event, user.userId, 'relay.self_models_sync', 'channel', id, { discovered: result.discovered, added: result.added })
  return result
})
