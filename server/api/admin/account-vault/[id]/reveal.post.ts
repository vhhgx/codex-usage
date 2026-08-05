import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { revealAccountVaultPassword } from '../../../../services/accounting'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-account-reveal:${admin.userId}:${id}`, 10, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await revealAccountVaultPassword(event, id)
    await writeAudit(event, admin.userId, 'account_vault.reveal', 'account_vault_entry', id)
    return result
  } catch (error) {
    await writeAudit(event, admin.userId, 'account_vault.reveal_failed', 'account_vault_entry', id, { securityEvent: true })
    throw error
  }
})
