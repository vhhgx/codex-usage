import { requireUser, writeAudit } from '../../../../../services/admin-auth'
import { revealSmsReceiverFetchUrl } from '../../../../../services/sms-receivers'
import { assertUserPoolAccess } from '../../../../../services/user-pool'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `pool-sms-receiver-credentials:${user.userId}:${id}`, 10, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const fetchUrl = await revealSmsReceiverFetchUrl(event, id, user.userId)
    await writeAudit(event, user.userId, 'pool.sms_receiver.credentials_view', 'sms_receiver', id)
    return { fetchUrl }
  } catch (error) {
    await writeAudit(event, user.userId, 'pool.sms_receiver.credentials_view_failed', 'sms_receiver', id, { securityEvent: true })
    throw error
  }
})
