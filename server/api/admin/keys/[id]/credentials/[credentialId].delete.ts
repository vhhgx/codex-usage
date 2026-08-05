import { auditedMutation, requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { revokeHubKeyCredential } from '../../../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const keyId = getRouterParam(event, 'id') || ''
  const credentialId = getRouterParam(event, 'credentialId') || ''
  return auditedMutation(event, async () => {
    const result = await revokeHubKeyCredential(event, keyId, credentialId)
    await writeAudit(event, admin.userId, 'key.revoke', 'hub_key_credential', credentialId, { keyId })
    return result
  })
})
