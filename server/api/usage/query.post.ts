import type { UsageRange, UsageSource } from '#shared/types/usage'
import { querySub2ApiUsage } from '../../services/sub2api'
import { queryUserUsage } from '../../services/user-usage'
import { enforceRateLimit } from '../../utils/rate-limit'

const ALLOWED_RANGES = new Set<UsageRange>(['today', '7d', '30d'])
const ALLOWED_SOURCES = new Set<UsageSource>(['cpa', 'sub2api'])

export default defineEventHandler(async (event) => {
  enforceRateLimit(event, 'user-usage-query', 10, 60 * 1000)
  const body = await readBody<{ apiKey?: unknown; range?: unknown; source?: unknown }>(event)
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  const range = typeof body?.range === 'string' ? body.range : '7d'
  const source = typeof body?.source === 'string' ? body.source : 'cpa'

  if (apiKey.length < 8 || apiKey.length > 512) {
    throw createError({ statusCode: 400, message: '请输入有效的 API Key' })
  }
  if (!ALLOWED_RANGES.has(range as UsageRange)) {
    throw createError({ statusCode: 400, message: '不支持的查询时间范围' })
  }
  if (!ALLOWED_SOURCES.has(source as UsageSource)) {
    throw createError({ statusCode: 400, message: '不支持的用量数据源' })
  }

  return source === 'sub2api'
    ? querySub2ApiUsage(event, apiKey, range as UsageRange)
    : queryUserUsage(event, apiKey, range as UsageRange)
})
