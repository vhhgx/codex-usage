import { auditedMutation, requireAdminWrite, writeAudit } from '../../../services/admin-auth'
import { createProbeModel } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const model = await createProbeModel(event, body)
    await writeAudit(event, admin.userId, 'probe_model.create', 'probe_model', model.id, { protocol: model.protocol, model: model.model })
    return { model }
  })
})
