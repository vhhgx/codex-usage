import { requireUser, writeAudit } from '../../../../../../services/admin-auth'
import { refreshUserPoolAccountSmsReceiverCode } from '../../../../../../services/sms-receivers'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `pool-account-sms:${user.userId}:${id}`, 12, 60_000)
  const result = await refreshUserPoolAccountSmsReceiverCode(event, user.userId, id)
  await writeAudit(event, user.userId, 'pool.account.sms_refresh', 'user_pool_account', id, { codeReceived: Boolean(result.code) })
  return { result }
})
