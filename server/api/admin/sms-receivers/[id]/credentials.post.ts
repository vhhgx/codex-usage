import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { revealSmsReceiverFetchUrl } from '../../../../services/sms-receivers'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-sms-receiver-credentials:${admin.userId}:${id}`, 10, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const fetchUrl = await revealSmsReceiverFetchUrl(event, id)
    await writeAudit(event, admin.userId, 'sms_receiver.credentials_view', 'sms_receiver', id)
    return { fetchUrl }
  } catch (error) {
    await writeAudit(event, admin.userId, 'sms_receiver.credentials_view_failed', 'sms_receiver', id, { securityEvent: true })
    throw error
  }
})
