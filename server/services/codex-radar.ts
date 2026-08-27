import type { CodexRadarResponse } from '#shared/types/codex-radar'
import {
  CODEX_RADAR_INTELLIGENCE_URL,
  CODEX_RADAR_URL,
  parseCodexRadarPayload
} from '#shared/utils/codex-radar'
import type { H3Event } from 'h3'
import { useRedis } from '../utils/redis'
import { canonicalModelId } from '#shared/utils/model-routing'

export { parseCodexRadarPayload } from '#shared/utils/codex-radar'

export async function fetchCodexRadar(): Promise<CodexRadarResponse> {
  let lastError: unknown
  for (const url of [CODEX_RADAR_INTELLIGENCE_URL, CODEX_RADAR_URL]) {
    try {
      const payload = await $fetch<unknown>(url, {
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache'
        },
        timeout: 10_000,
        retry: 0
      })
      return parseCodexRadarPayload(payload)
    } catch (error) {
      lastError = error
    }
  }

  throw createError({
    statusCode: 502,
    message: lastError instanceof Error && lastError.message.startsWith('CodexRadar ')
      ? lastError.message
      : '暂时无法连接 CodexRadar'
  })
}

const RADAR_CACHE_KEY = 'hub:codex-radar:v1'
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max']

export async function cachedCodexRadar(event?: H3Event) {
  const redis = useRedis(event)
  const cached = await redis.get(RADAR_CACHE_KEY)
  if (cached) {
    try { return JSON.parse(cached) as CodexRadarResponse } catch {}
  }
  const radar = await fetchCodexRadar()
  await redis.set(RADAR_CACHE_KEY, JSON.stringify(radar), 'EX', 1800)
  return radar
}

export function selectRadarEffort(radar: CodexRadarResponse, model: string, maxEffort: string) {
  const normalized = canonicalModelId(model).toLowerCase()
  const maxRank = EFFORT_ORDER.indexOf(maxEffort.toLowerCase())
  const ceiling = maxRank < 0 ? EFFORT_ORDER.indexOf('high') : maxRank
  return radar.models
    .filter(item => canonicalModelId(item.model).toLowerCase() === normalized)
    .filter(item => {
      const rank = EFFORT_ORDER.indexOf(item.reasoningEffort.toLowerCase())
      return rank >= 0 && rank <= ceiling
    })
    .sort((left, right) => right.intelligenceScore - left.intelligenceScore || EFFORT_ORDER.indexOf(right.reasoningEffort.toLowerCase()) - EFFORT_ORDER.indexOf(left.reasoningEffort.toLowerCase()))[0]?.reasoningEffort || null
}
