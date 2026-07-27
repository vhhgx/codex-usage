import type { CodexRefreshAllResponse } from '#shared/types/codex'
import { refreshAllCodexQuotas } from '../../services/cpa'
import { enforceRateLimit } from '../../utils/rate-limit'

export default defineEventHandler(async (event): Promise<CodexRefreshAllResponse> => {
  enforceRateLimit(event, 'codex-refresh-all', 12, 60 * 1000)
  const { accounts, results } = await refreshAllCodexQuotas(event)
  return {
    accounts,
    results,
    successCount: results.filter((result) => result.quotaStatus === 'success').length,
    failureCount: results.filter((result) => result.quotaStatus === 'error').length,
    generatedAt: Date.now()
  }
})
