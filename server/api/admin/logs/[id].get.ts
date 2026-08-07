import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { requestLogDetail } from '../../../services/hub-analytics'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const detail = await requestLogDetail(event, id)
  await writeAudit(event, admin.userId, 'request_log.view', 'request_log', id)
  return detail
})
