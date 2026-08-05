import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { updateGroupRecord } from '../../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ channelIds?: unknown; channelRules?: unknown }>(event) || {}
  const channelIds = Array.isArray(body.channelIds) ? body.channelIds.map(String) : []
  const relations = 'channelRules' in body ? { channelRules: body.channelRules } : { channelIds }
  return auditedMutation(event, async () => {
    const group = await updateGroupRecord(event, id, relations, admin.userId)
    await writeAudit(event, admin.userId, 'group.channels_sync', 'group', id, { count: group.channelRules.length })
    return { group }
  })
})
