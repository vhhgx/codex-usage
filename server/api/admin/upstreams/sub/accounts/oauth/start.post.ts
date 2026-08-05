import { requireAccountAdmin, requireAdmin, writeAudit } from '../../../../../../services/admin-auth'
import { getAccountVaultEntry } from '../../../../../../services/accounting'
import { startManagedSub2ApiOpenAiOAuth } from '../../../../../../services/sub2api-oauth'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-account-oauth-start', 10, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const accountVaultId = typeof body.accountVaultId === 'string' && body.accountVaultId ? body.accountVaultId : null
  if (accountVaultId) {
    await requireAccountAdmin(event)
    await getAccountVaultEntry(event, accountVaultId)
  }
  const result = await startManagedSub2ApiOpenAiOAuth(event, {
    adminId: admin.userId,
    proxyId: body.proxyId,
    useDefaultProxy: !Object.prototype.hasOwnProperty.call(body, 'proxyId'),
    accountVaultId
  })
  await writeAudit(event, admin.userId, 'sub.account.oauth-start', 'sub2api_oauth', null, {
    provider: 'openai',
    expiresAt: result.expiresAt,
    accountVaultId
  })
  return result
})
