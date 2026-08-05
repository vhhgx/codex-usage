import { requireAdmin, writeAudit } from '../../../../../../services/admin-auth'
import { verifyManagedCpaAuthFile } from '../../../../../../services/cpa'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-cpa-verify', 30, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const result = await verifyManagedCpaAuthFile(event, id)
  await writeAudit(event, admin.userId, 'cpa.auth-file.verify', 'cpa_auth_file', id, result)
  return result
})
