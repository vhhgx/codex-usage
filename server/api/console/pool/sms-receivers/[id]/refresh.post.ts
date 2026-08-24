import { requireUser, writeAudit } from '../../../../../services/admin-auth'
import { refreshSmsReceiverCode } from '../../../../../services/sms-receivers'
import { enforceRateLimit } from '../../../../../utils/rate-limit'
import { assertUserPoolAccess } from '../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `pool-sms-refresh:${user.userId}:${id}`, 12, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  const result = await refreshSmsReceiverCode(event, id, user.userId)
  await writeAudit(event, user.userId, 'pool.sms_receiver.refresh', 'sms_receiver', id, { codeReceived: Boolean(result.code) })
  return { result }
})
