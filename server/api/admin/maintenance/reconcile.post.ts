import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { reconcileHubUsageCounters } from '../../../services/hub-limits'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const result = await reconcileHubUsageCounters(event)
  await writeAudit(event, admin.userId, 'usage.reconcile', 'usage_rollup', null, result)
  return result
})
