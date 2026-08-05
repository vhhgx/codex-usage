import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { createManagedSub2ApiProxy } from '../../../../../services/sub2api-admin'
import { proxyPayload } from '../../../../../services/upstream-input'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-proxy-create', 15, 60_000)
  const payload = await proxyPayload(event, await readBody<Record<string, unknown>>(event) || {}, true)
  const proxy = await runUpstreamOperation(event, {
    adminId: admin.userId,
    connectionId: 'sub2api',
    action: 'sub.proxy.create',
    targetType: 'sub2api_proxy',
    targetRef: String(payload.name),
    fingerprint: payload,
    safeSummary: { name: payload.name, protocol: payload.protocol, host: payload.host, port: payload.port }
  }, async () => ({ result: await createManagedSub2ApiProxy(event, payload) }))
  await writeAudit(event, admin.userId, 'sub.proxy.create', 'sub2api_proxy', proxy.id, {
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    result: 'succeeded',
    requestId: getResponseHeader(event, 'x-request-id')
  })
  return { proxy }
})
