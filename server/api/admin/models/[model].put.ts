import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { updateModelConfiguration } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const model = decodeURIComponent(getRouterParam(event, 'model') || '').trim()
  if (!model) throw createError({ statusCode: 400, message: '模型不能为空' })
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const models = await updateModelConfiguration(event, model, body)
    await writeAudit(event, admin.userId, 'model.update', 'model', model)
    return { models }
  })
})
