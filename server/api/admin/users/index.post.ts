import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { createUserRecord } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const user = await createUserRecord(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'user.create', 'user', user.id, { username: user.username, role: user.role })
    return { user }
  })
})
