import { requireAdmin, writeAudit } from '../../services/admin-auth'
import { getHubAlertStatus } from '../../services/hub-alerts'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const result = await getHubAlertStatus(event)
  await writeAudit(event, admin.userId, 'alerts.view', 'system', null, { active: result.active.length })
  return result
})
