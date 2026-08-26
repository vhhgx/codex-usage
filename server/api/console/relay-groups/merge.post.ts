import { requireUser, writeAudit } from '../../../services/admin-auth'
import { mergeUserRelayGroups } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ targetGroupId?: string; sourceGroupIds?: unknown }>(event) || {}
  const result = await mergeUserRelayGroups(event, user.userId, body.targetGroupId || '', body.sourceGroupIds)
  await writeAudit(event, user.userId, 'user_relay_group.merge', 'user_relay_group', body.targetGroupId || '', { sourceGroupIds: body.sourceGroupIds })
  return result
})
