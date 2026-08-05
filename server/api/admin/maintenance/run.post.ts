import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { runHubMaintenance } from '../../../services/hub-maintenance'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const result = await runHubMaintenance(event)
  await writeAudit(event, admin.userId, 'maintenance.run', 'system_settings', '1', {
    keysExpired: result.keysExpired,
    keyStatesCleared: result.keyStatesCleared,
    bodyObjectsDeleted: result.bodyObjectsDeleted,
    metadataDeleted: result.metadataDeleted,
    bodyCleanupFailed: Boolean(result.bodyCleanupError)
  })
  return result
})
