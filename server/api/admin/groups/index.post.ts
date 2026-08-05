import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { createGroupRecord } from '../../../services/access-control'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const group = await createGroupRecord(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'group.create', 'group', group.id, { name: group.name })
    return { group }
  })
})
