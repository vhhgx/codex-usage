import { requireUser, writeAudit } from '../../../../../../services/admin-auth'
import { moveUserRelayAccount } from '../../../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const groupId = getRouterParam(event, 'groupId') || ''
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ targetGroupId?: string }>(event) || {}
  const result = await moveUserRelayAccount(event, user.userId, groupId, id, body.targetGroupId || '')
  await writeAudit(event, user.userId, 'user_relay.move', 'channel', id, { fromGroupId: groupId, toGroupId: body.targetGroupId })
  return result
})
