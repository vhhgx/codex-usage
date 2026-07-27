import type { Sub2ApiAccountQuotaResult } from '#shared/types/sub2api-admin'
import { fetchSub2ApiAccountQuota, findSub2ApiAccount } from '../../../services/sub2api-admin'
import { enforceRateLimit } from '../../../utils/rate-limit'

export default defineEventHandler(async (event): Promise<Sub2ApiAccountQuotaResult> => {
  enforceRateLimit(event, 'sub2api-refresh-one', 30, 60 * 1000)
  const id = getRouterParam(event, 'id') || ''
  const account = await findSub2ApiAccount(event, id)
  if (!account) throw createError({ statusCode: 404, message: 'Sub2API 账号不存在' })
  return fetchSub2ApiAccountQuota(event, account, true)
})
