import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { checkinAllUserRelays } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return auditedMutation(event, async () => {
    const result = await checkinAllUserRelays(event, user.userId)
    await writeAudit(event, user.userId, 'relay.self_checkin_all', 'channel', null, result.summary)
    return result
  })
})
