import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { setManagedCpaDefaultProxy } from '../../../../../services/cpa'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-cpa-proxy-default', 30, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const proxyId = body.proxyId === null || body.proxyId === '' ? null : String(body.proxyId || '')
  if (body.proxyId !== null && body.proxyId !== '' && !proxyId) {
    throw createError({ statusCode: 400, message: '默认代理 ID 无效' })
  }
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId,
    connectionId: 'cpa',
    action: 'cpa.proxy.default.update',
    targetType: 'proxy_pool',
    targetRef: proxyId,
    fingerprint: { proxyId },
    safeSummary: { proxyId }
  }, async () => ({ result: await setManagedCpaDefaultProxy(event, proxyId) }))
  await writeAudit(event, admin.userId, 'cpa.proxy.default.update', 'system_settings', '1', {
    defaultProxyId: result.cpaDefaultProxyId,
    result: 'succeeded',
    requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
