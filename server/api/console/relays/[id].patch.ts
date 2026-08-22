import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { updateUserRelay } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const relay = await updateUserRelay(event, user.userId, id, body)
    await writeAudit(event, user.userId, 'relay.self_update', 'channel', id, { fields: Object.keys(body) })
    return relay
  })
})
