import { requireAccountAdmin, writeAudit } from '../../../../../services/admin-auth'
import { refreshAccountSmsReceiverCode } from '../../../../../services/sms-receivers'
import { enforceRateLimit } from '../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-account-sms-refresh:${admin.userId}:${id}`, 12, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await refreshAccountSmsReceiverCode(event, id)
    await writeAudit(event, admin.userId, 'account_vault.sms_refresh', 'account_vault_entry', id, {
      receiverId: result.receiverId,
      codeReceived: Boolean(result.code)
    })
    return { result }
  } catch (error) {
    await writeAudit(event, admin.userId, 'account_vault.sms_refresh_failed', 'account_vault_entry', id, { securityEvent: true })
    throw error
  }
})
