import type { CodexQuotaResult } from '#shared/types/codex'
import { fetchCodexQuota, listCodexAccounts } from '../../../services/cpa'
import { enforceRateLimit } from '../../../utils/rate-limit'

export default defineEventHandler(async (event): Promise<CodexQuotaResult> => {
  await enforceRateLimit(event, 'codex-refresh-one', 90, 60 * 1000)
  const id = getRouterParam(event, 'id')
  const accounts = await listCodexAccounts(event)
  const account = accounts.find((item) => item.view.id === id && !item.view.disabled)
  if (!account) {
    throw createError({ statusCode: 404, message: 'Codex 账号不存在或当前不可用' })
  }
  return fetchCodexQuota(event, account)
})
