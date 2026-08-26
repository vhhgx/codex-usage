import { requireUser } from '../../services/admin-auth'
import { listProbeModels } from '../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  return { models: await listProbeModels(event) }
})
