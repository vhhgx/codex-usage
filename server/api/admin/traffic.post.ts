import { requireAdmin, writeAudit } from '../../services/admin-auth'
import { setDrainState } from '../../services/hub-traffic'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody<{ enabled?: boolean; ttlSeconds?: number; reason?: string }>(event) || {}
  const result = await setDrainState(event, body.enabled === true, body)
  await writeAudit(event, admin.userId, body.enabled === true ? 'traffic.drain.start' : 'traffic.drain.stop', 'system', null, { ttlSeconds: body.ttlSeconds || null, activeRequests: result.activeRequests })
  return result
})
