import { requireAdmin, writeAudit } from '../../../services/admin-auth'
import { listHubKeyCredentials, listHubKeys } from '../../../services/hub-admin'
import { hubKeyUsageDetail } from '../../../services/hub-analytics'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const item = (await listHubKeys(event)).find(key => key.id === id)
  if (!item) throw createError({ statusCode: 404, message: 'Hub Key 不存在' })
  const [usage, credentials] = await Promise.all([hubKeyUsageDetail(event, id), listHubKeyCredentials(event, id)])
  await writeAudit(event, admin.userId, 'hub_key.view', 'hub_key', id, { name: item.name })
  return { item, credentials, ...usage }
})
