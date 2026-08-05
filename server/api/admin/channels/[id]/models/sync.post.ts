import { auditedMutation, requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { syncChannelModelsFromUpstream } from '../../../../../services/hub-model-discovery'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const channelId = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await syncChannelModelsFromUpstream(event, channelId)
    await writeAudit(event, admin.userId, 'channel.models.sync', 'channel', channelId, {
      discovered: result.discovered,
      added: result.added
    })
    return result
  })
})
