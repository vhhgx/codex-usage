import { requireAdmin, writeAudit } from '../../services/admin-auth'
import { getKeyActivity } from '../../services/key-activity'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const query = getQuery(event)
  const date = typeof query.date === 'string' ? query.date : undefined
  const result = await getKeyActivity(event, date)
  await writeAudit(event, admin.userId, 'hub_key.activity', 'request_log', null, { date: date || null, count: result.keys.length })
  return result
})
