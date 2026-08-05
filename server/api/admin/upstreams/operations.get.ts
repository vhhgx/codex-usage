import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { listUpstreamOperations } from '../../../services/upstream-operations'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const operations = await listUpstreamOperations(event, Number(getQuery(event).limit || 100))
  await writeAudit(event, admin.userId, 'upstream.operations.list', 'upstream_operation', null, { count: operations.length })
  return { operations }
})
