import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { generateAccountVaultTotp } from '../../../../services/accounting'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-account-totp:${admin.userId}:${id}`, 30, 60_000)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  try {
    const result = await generateAccountVaultTotp(event, id)
    await writeAudit(event, admin.userId, 'account_vault.totp_generate', 'account_vault_entry', id)
    return { result }
  } catch (error) {
    await writeAudit(event, admin.userId, 'account_vault.totp_generate_failed', 'account_vault_entry', id, { securityEvent: true })
    throw error
  }
})
