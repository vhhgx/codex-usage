import type { CodexRadarResponse } from '#shared/types/codex-radar'
import {
  CODEX_RADAR_INTELLIGENCE_URL,
  CODEX_RADAR_URL,
  parseCodexRadarPayload
} from '#shared/utils/codex-radar'

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
