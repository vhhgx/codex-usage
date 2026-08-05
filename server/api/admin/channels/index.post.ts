import { auditedMutation, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { createChannelRecord } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = await readBody<Record<string, unknown>>(event)
  return auditedMutation(event, async () => {
    const channel = await createChannelRecord(event, body || {})
    await writeAudit(event, admin.userId, 'channel.create', 'channel', channel.id, { name: channel.name, type: channel.type })
    return channel
  })
})
