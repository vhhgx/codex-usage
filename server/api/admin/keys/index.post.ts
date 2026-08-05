import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { createHubKeyRecord } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const result = await createHubKeyRecord(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'key.create', 'hub_key', result.item.id, { name: result.item.name })
    return result
  })
})
