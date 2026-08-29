import { auditedMutation, requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { syncChannelModelsFromUpstream } from '../../../../../services/hub-model-discovery'
import { invalidateChannelAccess } from '../../../../../services/channel-access'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const channelId = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-channel-model-sync:${admin.userId}:${channelId}`, 5, 60_000)
  return auditedMutation(event, async () => {
    const result = await syncChannelModelsFromUpstream(event, channelId)
    await invalidateChannelAccess(event, [channelId])
    await writeAudit(event, admin.userId, 'channel.models.sync', 'channel', channelId, {
      discovered: result.discovered,
      added: result.added
    })
    return result
  })
})
