import { auditedMutation, requireUser, writeAudit } from '../../../../services/admin-auth'
import { updateUserKeyChannels } from '../../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ channelIds?: unknown; routeMode?: unknown }>(event) || {}
  const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter((value): value is string => typeof value === 'string') : []
  const routeMode = body.routeMode === 'private_only' ? 'private_only' : 'platform_only'
  return auditedMutation(event, async () => {
    const result = await updateUserKeyChannels(event, user.userId, id, channelIds, routeMode)
    await writeAudit(event, user.userId, 'key.self_channels_sync', 'hub_key', id, { channelIds, routeMode })
    return result
  })
})
