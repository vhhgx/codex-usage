import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { listChannels } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const channels = await listChannels(event)
  await writeAudit(event, admin.userId, 'channel.list', 'channel', null, { count: channels.length })
  return { channels }
})
