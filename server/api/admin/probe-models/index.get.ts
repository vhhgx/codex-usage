import { requireAdmin } from '../../../services/admin-auth'
import { listProbeModels } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { models: await listProbeModels(event, true) }
})
