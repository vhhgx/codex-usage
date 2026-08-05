import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { updateChannelRecord } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const channel = await updateChannelRecord(event, id, body)
    await writeAudit(event, admin.userId, 'channel.update', 'channel', id, { name: channel.name })
    return channel
  })
})
