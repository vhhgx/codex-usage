import { auditedMutation, requireAdmin, writeAudit } from '../../services/admin-auth'
import { updateHubSettings } from '../../services/hub-settings'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const settings = await updateHubSettings(event, body)
    await writeAudit(event, admin.userId, 'settings.update', 'system_settings', '1')
    const { sub2apiDefaultProxyUpstreamId: _internalProxyId, ...publicSettings } = settings
    return publicSettings
  })
})
