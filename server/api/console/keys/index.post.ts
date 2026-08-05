import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { createUserKey } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const result = await createUserKey(event, user.userId, body)
    await writeAudit(event, user.userId, 'key.self_create', 'hub_key', result.item.id, { name: result.item.name })
    return result
  })
})
