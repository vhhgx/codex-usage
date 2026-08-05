import { requireAdmin, writeAudit } from '../../../../../../services/admin-auth'
import { testManagedSub2ApiProxy } from '../../../../../../services/sub2api-admin'
import { runUpstreamOperation } from '../../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-proxy-quality', 20, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId,
    connectionId: 'sub2api',
    action: 'sub.proxy.quality-check',
    targetType: 'sub2api_proxy',
    targetRef: id,
    fingerprint: { id, at: Math.floor(Date.now() / 10_000) },
    safeSummary: { check: 'quality' }
  }, async () => ({ result: await testManagedSub2ApiProxy(event, id, true) }))
  await writeAudit(event, admin.userId, 'sub.proxy.quality-check', 'sub2api_proxy', id, {
    ok: result.ok,
    latencyMs: result.latencyMs,
    qualityScore: result.qualityScore,
    requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
