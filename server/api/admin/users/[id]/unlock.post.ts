import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { updateUserRecord } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const user = await updateUserRecord(event, id, { status: 'active' }, admin.userId)
    await writeAudit(event, admin.userId, 'user.unlock', 'user', id)
    return { user }
  })
})
