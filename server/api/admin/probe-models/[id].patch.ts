import { requireAdmin } from '../../../services/admin-auth'
import { updateProbeModel } from '../../../services/probe-model-catalog'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: '缺少模型ID' })

  const body = await readBody(event)
  return await updateProbeModel(event, id, body)
})
