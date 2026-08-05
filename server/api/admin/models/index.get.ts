import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { listModelConfiguration } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const models = await listModelConfiguration(event)
  await writeAudit(event, admin.userId, 'model.list', 'model', null, { count: models.length })
  return { models }
})
