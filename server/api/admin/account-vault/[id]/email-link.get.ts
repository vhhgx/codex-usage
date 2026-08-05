import { requireAccountAdmin, writeAudit } from '../../../../services/admin-auth'
import { revealAccountVaultEmailCodeUrl } from '../../../../services/accounting'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  await enforceRateLimit(event, `admin-account-email-link:${admin.userId}:${id}`, 20, 60_000)
  const url = await revealAccountVaultEmailCodeUrl(event, id)
  await writeAudit(event, admin.userId, 'account_vault.email_link_open', 'account_vault_entry', id)
  setResponseHeaders(event, { 'cache-control': 'no-store, private', pragma: 'no-cache' })
  return sendRedirect(event, url, 302)
})
