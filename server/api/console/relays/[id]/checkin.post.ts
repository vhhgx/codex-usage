import { auditedMutation, requireUser, writeAudit } from '../../../../services/admin-auth'
import { checkinUserRelay } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const result = await checkinUserRelay(event, user.userId, id)
    await writeAudit(event, user.userId, 'relay.self_checkin', 'channel', id, { status: result.status, awardedQuota: result.awardedQuota })
    return result
  })
})
