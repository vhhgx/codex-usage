import { auditedMutation, requireAdminWrite, writeAudit } from '../../../services/admin-auth'
import { deleteProbeModel } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    await deleteProbeModel(event, id)
    await writeAudit(event, admin.userId, 'probe_model.delete', 'probe_model', id)
    return { success: true }
  })
})
