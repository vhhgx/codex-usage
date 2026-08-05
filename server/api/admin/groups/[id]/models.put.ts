import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { updateGroupRecord } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ models?: unknown }>(event) || {}
  const models = Array.isArray(body.models) ? body.models.map(String) : []
  return auditedMutation(event, async () => {
    const group = await updateGroupRecord(event, id, { models }, admin.userId)
    await writeAudit(event, admin.userId, 'group.models_sync', 'group', id, { count: models.length })
    return { group }
  })
})
