import { requireUser, writeAudit } from '../../../../../../services/admin-auth'
import { duplicateUserRelay } from '../../../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const result = await duplicateUserRelay(event, user.userId, id, await readBody<Record<string, unknown>>(event) || {})
  await writeAudit(event, user.userId, 'user_relay.duplicate', 'channel', id, { duplicateId: result.id })
  return result
})
