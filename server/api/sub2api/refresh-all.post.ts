import type { Sub2ApiAccountsResponse } from '#shared/types/sub2api-admin'
import { getAllSub2ApiAccountQuotas } from '../../services/sub2api-admin'
import { enforceRateLimit } from '../../utils/rate-limit'

export default defineEventHandler(async (event): Promise<Sub2ApiAccountsResponse> => {
  enforceRateLimit(event, 'sub2api-refresh-all', 6, 60 * 1000)
  const results = await getAllSub2ApiAccountQuotas(event, true)
  return {
    results,
    accountCount: results.length,
    successCount: results.filter((result) => result.quotaStatus === 'success').length,
    failureCount: results.filter((result) => result.quotaStatus === 'error').length,
    generatedAt: Date.now()
  }
})
