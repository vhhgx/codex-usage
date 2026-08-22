import { auditedMutation, requireUser, writeAudit } from '../../../services/admin-auth'
import { createUserRelay } from '../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const relay = await createUserRelay(event, user.userId, body)
    await writeAudit(event, user.userId, 'relay.self_create', 'channel', relay.id, { name: relay.name, protocols: relay.protocols.map(item => item.protocol) })
    return relay
  })
})
