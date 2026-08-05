import { requireAdmin, writeAudit } from '../../services/admin-auth'
import { getDrainState } from '../../services/hub-traffic'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const result = await getDrainState(event)
  await writeAudit(event, admin.userId, 'traffic.view', 'system')
  return result
})
