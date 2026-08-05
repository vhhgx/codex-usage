import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { refreshSmsReceiverCode } from '../../../../services/sms-receivers'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-sms-refresh:${admin.userId}:${id}`, 12, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await refreshSmsReceiverCode(event, id)
    await writeAudit(event, admin.userId, 'sms_receiver.refresh', 'sms_receiver', id, {
      codeReceived: Boolean(result.code)
    })
    return { result }
  } catch (error) {
    await writeAudit(event, admin.userId, 'sms_receiver.refresh_failed', 'sms_receiver', id, { securityEvent: true })
    throw error
  }
})
