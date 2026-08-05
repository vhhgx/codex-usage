import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { updateGroupRecord } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const group = await updateGroupRecord(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, 'group.update', 'group', id, { fields: Object.keys(body) })
    return { group }
  })
})
