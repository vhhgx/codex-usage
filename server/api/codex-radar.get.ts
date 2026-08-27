import type { CodexRadarResponse } from '#shared/types/codex-radar'
import { cachedCodexRadar } from '../services/codex-radar'
import { enforceRateLimit } from '../utils/rate-limit'

export default defineEventHandler(async (event): Promise<CodexRadarResponse> => {
  await enforceRateLimit(event, 'codex-radar', 20, 60 * 1000)
  setResponseHeader(event, 'Cache-Control', 'private, max-age=60')
  return cachedCodexRadar(event)
})
