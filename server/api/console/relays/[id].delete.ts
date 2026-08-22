import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { deleteUserRelay } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await deleteUserRelay(event, user.userId, id)
    await writeAudit(event, user.userId, 'relay.self_delete', 'channel', id)
    return result
  })
})
