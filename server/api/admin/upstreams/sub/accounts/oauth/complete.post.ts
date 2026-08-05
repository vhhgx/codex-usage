import { requireAccountAdmin, requireAdmin, writeAudit } from '../../../../../../services/admin-auth'
import { markAccountVaultCodexAdded } from '../../../../../../services/accounting'
import {
  completeManagedSub2ApiOpenAiOAuth,
  sub2ApiOAuthFingerprint
} from '../../../../../../services/sub2api-oauth'
import { runUpstreamOperation } from '../../../../../../services/upstream-operations'
import { enforceRateLimit } from '../../../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  await enforceRateLimit(event, 'upstream-sub-account-oauth-complete', 10, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const accountVaultId = typeof body.accountVaultId === 'string' && body.accountVaultId ? body.accountVaultId : null
  if (accountVaultId) await requireAccountAdmin(event)
  const flowFingerprint = sub2ApiOAuthFingerprint(body.flowId)
  const callbackFingerprint = sub2ApiOAuthFingerprint(body.callbackUrl)
  const targetRef = `oauth:${flowFingerprint.slice(0, 16)}`
  const account = await runUpstreamOperation(event, {
    adminId: admin.userId,
    connectionId: 'sub2api',
    action: 'sub.account.oauth-complete',
    targetType: 'sub2api_account',
    targetRef,
    fingerprint: {
      flowFingerprint,
      callbackFingerprint,
      name: body.name,
      concurrency: body.concurrency,
      priority: body.priority,
      groupIds: body.groupIds,
      schedulable: body.schedulable,
      accountVaultId
    },
    safeSummary: {
      provider: 'openai',
      name: typeof body.name === 'string' ? body.name.trim() : '',
      groupCount: Array.isArray(body.groupIds) ? body.groupIds.length : 0,
      schedulable: body.schedulable !== false
    }
  }, async () => ({
    result: await completeManagedSub2ApiOpenAiOAuth(event, admin.userId, {
      flowId: body.flowId,
      callbackUrl: body.callbackUrl,
      name: body.name,
      concurrency: body.concurrency,
      priority: body.priority,
      groupIds: body.groupIds,
      schedulable: body.schedulable,
      accountVaultId
    })
  }))
  if (accountVaultId) await markAccountVaultCodexAdded(event, accountVaultId, account.id, admin.userId)
  await writeAudit(event, admin.userId, 'sub.account.oauth-complete', 'sub2api_account', account.id, {
    provider: 'openai',
    name: account.name,
    groupCount: account.groupIds.length,
    schedulable: account.schedulable,
    result: 'succeeded',
    requestId: getResponseHeader(event, 'x-request-id')
  })
  return { account, accountVaultId }
})
