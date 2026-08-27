import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { getUserRelay, moveUserRelayAccount } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ targetGroupId?: string }>(event) || {}
  const relay = await getUserRelay(event, user.userId, id)
  if (!relay.userRelayGroupId) throw createError({ statusCode: 409, message: '中转账号尚未归属站点' })
  const result = await moveUserRelayAccount(event, user.userId, relay.userRelayGroupId, id, body.targetGroupId || '')
  await writeAudit(event, user.userId, 'user_relay.move', 'channel', id, { fromGroupId: relay.userRelayGroupId, toGroupId: body.targetGroupId })
  return result
})
