import { requireAdmin } from '../../../services/admin-auth'
import { createProbeModel } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readBody(event)
  return await createProbeModel(event, body)
})
