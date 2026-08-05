import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { listHubKeys } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const keys = await listHubKeys(event)
  await writeAudit(event, admin.userId, 'hub_key.list', 'hub_key', null, { count: keys.length })
  return { keys }
})
