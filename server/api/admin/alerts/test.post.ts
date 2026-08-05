import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { testAlertWebhook } from '../../../services/hub-alerts'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const result = await testAlertWebhook(event)
  await writeAudit(event, admin.userId, 'alerts.test', 'system')
  return result
})
