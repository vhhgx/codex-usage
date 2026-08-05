import { requireAdmin, writeAudit } from '../../services/admin-auth'
import { overview } from '../../services/hub-analytics'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const query = getQuery(event) as Record<string, string | undefined>
  const result = await overview(event, query)
  await writeAudit(event, admin.userId, 'analytics.view', 'usage_rollup', null, {
    range: result.range.preset,
    filters: Object.fromEntries(['keyId', 'model', 'channelId', 'endpoint', 'status'].flatMap(key => query[key] ? [[key, String(query[key]).slice(0, 200)]] : []))
  })
  return result
})
