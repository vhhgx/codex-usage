import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { deleteUserKey } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await deleteUserKey(event, user.userId, id)
    await writeAudit(event, user.userId, 'key.self_delete', 'hub_key', id)
    return result
  })
})
