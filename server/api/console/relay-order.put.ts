import { auditedMutation, requireUser, writeAudit } from '../../services/admin-auth'
import { reorderUserRelays } from '../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ orderedIds?: unknown }>(event) || {}
  return auditedMutation(event, async () => {
    const sources = await reorderUserRelays(event, user.userId, body.orderedIds)
    await writeAudit(event, user.userId, 'relay.self_reorder', 'channel', null, { orderedIds: sources.map(source => source.id) })
    return { sources }
  })
})
