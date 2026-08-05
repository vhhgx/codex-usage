import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { updateUserKey } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const key = await updateUserKey(event, user.userId, id, body)
    await writeAudit(event, user.userId, 'key.update', 'hub_key', id, { fields: Object.keys(body) })
    return { key }
  })
})
