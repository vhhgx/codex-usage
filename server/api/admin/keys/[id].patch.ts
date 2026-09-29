import { auditedMutation, requireAccountAdmin, requireAdmin, writeAudit } from '../../../services/admin-auth'
import { updateHubKeyRecord } from '../../../services/hub-admin'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  // 修改归属（ownerUserId/groupId）等价于一次 Key 转移，必须与专职转移接口同样的权限门槛。
  const admin = 'ownerUserId' in body || 'groupId' in body
    ? await requireAccountAdmin(event)
    : await requireAdmin(event)
  return auditedMutation(event, async () => {
    const item = await updateHubKeyRecord(event, id, body)
    await writeAudit(event, admin.userId, 'key.update', 'hub_key', id, { name: item.name, status: item.status })
    return item
  })
})
