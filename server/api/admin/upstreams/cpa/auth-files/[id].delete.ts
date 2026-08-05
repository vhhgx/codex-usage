import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { deleteManagedCpaAuthFile, resolveManagedCpaAuthFile } from '../../../../../services/cpa'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-cpa-delete', 10, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const target = await resolveManagedCpaAuthFile(event, id)
  if (!target.view.disabled) throw createError({ statusCode: 409, message: '删除前请先停用认证文件并确认没有正在使用的请求' })
  const result = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'cpa', action: 'cpa.auth-file.delete',
    targetType: 'cpa_auth_file', targetRef: id,
    fingerprint: { id, name: target.view.name },
    idempotencyFallback: getHeader(event, 'idempotency-key') || null,
    safeSummary: { name: target.view.name }
  }, async () => ({ result: await deleteManagedCpaAuthFile(event, id) }))
  await writeAudit(event, admin.userId, 'cpa.auth-file.delete', 'cpa_auth_file', id, {
    name: target.view.name, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return result
})
