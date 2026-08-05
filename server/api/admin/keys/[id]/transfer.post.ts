import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { updateHubKeyRecord } from '../../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ ownerUserId?: unknown; groupId?: unknown }>(event) || {}
  if (typeof body.ownerUserId !== 'string' || typeof body.groupId !== 'string') throw createError({ statusCode: 400, message: '请选择目标用户和分组' })
  return auditedMutation(event, async () => {
    const item = await updateHubKeyRecord(event, id, { ownerUserId: body.ownerUserId, groupId: body.groupId })
    await writeAudit(event, admin.userId, 'key.transfer', 'hub_key', id, { ownerUserId: item.ownerUserId, groupId: item.groupId })
    return { key: item }
  })
})
