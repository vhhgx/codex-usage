import { requireUser } from '../../../../services/admin-auth'
import { discoverUserRelayModels } from '../../../../services/user-relays'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await enforceRateLimit(event, `user-relay-model-discovery:${user.userId}`, 20, 60_000)
  return discoverUserRelayModels(event, user.userId, await readBody<Record<string, unknown>>(event) || {})
})
