import { auditedMutation, requireAdminWrite, writeAudit } from '../../../../services/admin-auth'
import { updateChannelAccess } from '../../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdminWrite(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const channel = await updateChannelAccess(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, 'channel.access_sync', 'channel', id, {
      accessScope: channel.accessScope,
      grantedUserIds: channel.grantedUserIds,
      grantedGroupIds: channel.grantedGroupIds
    })
    return channel
  })
})
