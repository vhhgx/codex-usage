import { requireAdmin, writeAudit } from '../../../../../services/admin-auth'
import { resolveManagedCpaAuthFile, setManagedCpaAuthFileDisabled } from '../../../../../services/cpa'
import { runUpstreamOperation } from '../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-cpa-status', 30, 60_000)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ disabled?: unknown }>(event) || {}
  if (typeof body.disabled !== 'boolean') throw createError({ statusCode: 400, message: 'disabled 必须是布尔值' })
  const target = await resolveManagedCpaAuthFile(event, id)
  const file = await runUpstreamOperation(event, {
    adminId: admin.userId, connectionId: 'cpa', action: 'cpa.auth-file.status',
    targetType: 'cpa_auth_file', targetRef: id,
    fingerprint: { id, disabled: body.disabled }, safeSummary: { name: target.view.name, disabled: body.disabled }
  }, async () => ({ result: await setManagedCpaAuthFileDisabled(event, id, body.disabled as boolean) }))
  await writeAudit(event, admin.userId, 'cpa.auth-file.status', 'cpa_auth_file', id, {
    name: target.view.name, disabled: body.disabled, result: 'succeeded', requestId: getResponseHeader(event, 'x-request-id')
  })
  return { file }
})
