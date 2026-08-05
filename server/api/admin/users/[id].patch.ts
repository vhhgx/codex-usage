import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { updateUserRecord } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const user = await updateUserRecord(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, body.status === 'disabled' ? 'user.disable' : 'user.update', 'user', id, { fields: Object.keys(body).filter(key => key !== 'password') })
    return { user }
  })
})
