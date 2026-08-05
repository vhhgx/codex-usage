import { auditedMutation, requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { setManagedSub2ApiDefaultProxy } from '../../../../../services/sub2api-admin'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-proxy-default', 30, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const proxyId = body.proxyId === null || body.proxyId === '' ? null : String(body.proxyId || '')
  if (body.proxyId !== null && body.proxyId !== '' && !proxyId) {
    throw createError({ statusCode: 400, message: '默认代理 ID 无效' })
  }
  return auditedMutation(event, async () => {
    const result = await setManagedSub2ApiDefaultProxy(event, proxyId)
    await writeAudit(event, admin.userId, 'sub.proxy.default.update', 'system_settings', '1', {
      defaultProxyId: result.defaultProxyId
    })
    return result
  })
})
