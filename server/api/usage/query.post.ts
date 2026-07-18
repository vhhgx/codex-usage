import type { UsageRange } from '#shared/types/usage'
import { queryUserUsage } from '../../services/user-usage'
import { enforceRateLimit } from '../../utils/rate-limit'

const ALLOWED_RANGES = new Set<UsageRange>(['today', '7d', '30d'])

export default defineEventHandler(async (event) => {
  enforceRateLimit(event, 'user-usage-query', 10, 60 * 1000)
  const body = await readBody<{ apiKey?: unknown; range?: unknown }>(event)
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  const range = typeof body?.range === 'string' ? body.range : '7d'

  if (apiKey.length < 8 || apiKey.length > 512) {
    throw createError({ statusCode: 400, message: '请输入有效的 API Key' })
  }
  if (!ALLOWED_RANGES.has(range as UsageRange)) {
    throw createError({ statusCode: 400, message: '不支持的查询时间范围' })
  }

  return queryUserUsage(event, apiKey, range as UsageRange)
})
