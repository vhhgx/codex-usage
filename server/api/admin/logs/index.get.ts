import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { listRequestLogs } from '../../../services/hub-analytics'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const query = getQuery(event) as Record<string, string | undefined>
  const result = await listRequestLogs(event, query)
  const filterKeys = ['keyId', 'channelId', 'resourceType', 'resourceId', 'model', 'endpoint', 'status', 'from', 'to']
  const filters = Object.fromEntries(filterKeys.flatMap(key => query[key] ? [[key, String(query[key]).slice(0, 200)]] : []))
  await writeAudit(event, admin.userId, 'request_log.list', 'request_log', null, { page: result.page, count: result.items.length, filters })
  return result
})
