import { requireAdmin, writeAudit } from '../../services/admin-auth'
import { listAuditLogs } from '../../services/hub-audits'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const result = await listAuditLogs(event, getQuery(event) as Record<string, string | undefined>)
  await writeAudit(event, admin.userId, 'audit.list', 'audit_log', null, { count: result.items.length })
  return result
})
