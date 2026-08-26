import { auditedMutation, requireAdminWrite, writeAudit } from '../../../services/admin-auth'
import { updateProbeModel } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const model = await updateProbeModel(event, id, body)
    await writeAudit(event, admin.userId, 'probe_model.update', 'probe_model', id, { protocol: model.protocol, model: model.model })
    return { model }
  })
})
