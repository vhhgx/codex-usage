import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { updateHubKeyRecord } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await updateHubKeyRecord(event, id, body)
    await writeAudit(event, admin.userId, 'key.update', 'hub_key', id, { name: item.name, status: item.status })
    return item
  })
})
