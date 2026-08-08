import { requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { revealAccountVaultPasswords } from '../../../services/accounting'
import { enforceRateLimit } from '../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  await enforceRateLimit(event, `admin-account-passwords:${admin.userId}`, 30, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const items = await revealAccountVaultPasswords(event)
    await writeAudit(event, admin.userId, 'account_vault.passwords_view', 'account_vault_entry', null, { count: items.length })
    return { items }
  } catch (error) {
    await writeAudit(event, admin.userId, 'account_vault.passwords_view_failed', 'account_vault_entry', null, { securityEvent: true })
    throw error
  }
})
