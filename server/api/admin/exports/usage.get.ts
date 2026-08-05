import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { buildUsageExport } from '../../../services/hub-export'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const query = getQuery(event) as Record<string, string | undefined>
  const result = await buildUsageExport(event, query)
  const count = result.format === 'json' ? result.records.length : result.count
  await writeAudit(event, admin.userId, 'usage.export', 'usage_rollup', null, { format: result.format, count, from: result.from, to: result.to })
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'content-disposition', `attachment; filename="zephyr-usage-${new Date().toISOString().slice(0, 10)}.${result.format}"`)
  if (result.format === 'json') return { from: result.from, to: result.to, records: result.records }
  setResponseHeader(event, 'content-type', 'text/csv; charset=utf-8')
  return result.csv
})
