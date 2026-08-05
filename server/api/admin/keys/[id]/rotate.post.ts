import { auditedMutation, requireAdmin, writeAudit } from '../../../../services/admin-auth'
import { rotateHubKeyCredential } from '../../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ graceSeconds?: number }>(event) || {}
  return auditedMutation(event, async () => {
    const result = await rotateHubKeyCredential(event, id, Number(body.graceSeconds ?? 3600), admin.userId)
    await writeAudit(event, admin.userId, 'key.rotate', 'hub_key', id, { credentialId: result.credential.id, graceSeconds: result.graceSeconds })
    return result
  })
})
