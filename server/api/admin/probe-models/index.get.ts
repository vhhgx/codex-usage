import { requireAdmin } from '../../../services/admin-auth'
import { listProbeModels } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return await listProbeModels(event, true) // includeDisabled = true
})
