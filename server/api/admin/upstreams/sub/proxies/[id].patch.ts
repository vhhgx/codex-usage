import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { syncManagedCpaDefaultProxy } from '../../../../../services/cpa'
import { updateManagedSub2ApiProxy } from '../../../../../services/sub2api-admin'
import { proxyPayload } from '../../../../../services/upstream-input'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-proxy-update', 30, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const payload = await proxyPayload(event, await readBody<Record<string, unknown>>(event) || {}, false)
  if (!Object.keys(payload).length) throw createError({ statusCode: 400, message: '没有可更新的代理字段' })
  const proxy = await runUpstreamOperation(event, {
    adminId: admin.userId,
    connectionId: 'sub2api',
    action: 'sub.proxy.update',
    targetType: 'sub2api_proxy',
    targetRef: id,
    fingerprint: { id, payload },
    safeSummary: { fields: Object.keys(payload).filter(field => field !== 'password') }
  }, async () => {
    const result = await updateManagedSub2ApiProxy(event, id, payload)
    try {
      await syncManagedCpaDefaultProxy(event, id)
    } catch {
      throw createError({
        statusCode: 502,
        message: '代理已在代理池更新，但 CPA 默认代理同步失败，请刷新后重新保存 CPA 默认代理',
        data: { reconciliationRequired: true }
      })
    }
    return { result }
  })
  await writeAudit(event, admin.userId, 'sub.proxy.update', 'sub2api_proxy', id, {
    fields: Object.keys(payload).filter(field => field !== 'password'),
    result: 'succeeded',
    requestId: getResponseHeader(event, 'x-request-id')
  })
  return { proxy }
})
