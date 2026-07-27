import type { CodexRadarResponse } from '#shared/types/codex-radar'
import { fetchCodexRadar } from '../services/codex-radar'
import { enforceRateLimit } from '../utils/rate-limit'

export default defineEventHandler(async (event): Promise<CodexRadarResponse> => {
  enforceRateLimit(event, 'codex-radar', 20, 60 * 1000)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return fetchCodexRadar()
})
