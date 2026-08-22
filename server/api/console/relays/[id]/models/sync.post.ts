import { requireUser, writeAudit } from '../../../../../services/admin-auth'
import { syncUserRelayModels } from '../../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const result = await syncUserRelayModels(event, user.userId, id)
  await writeAudit(event, user.userId, 'relay.self_models_sync', 'channel', id, { discovered: result.discovered, added: result.added })
  return result
})
