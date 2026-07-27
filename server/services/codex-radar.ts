import type { CodexRadarResponse } from '#shared/types/codex-radar'
import {
  CODEX_RADAR_URL,
  parseCodexRadarPayload
} from '#shared/utils/codex-radar'

export { parseCodexRadarPayload } from '#shared/utils/codex-radar'

export async function fetchCodexRadar(): Promise<CodexRadarResponse> {
  try {
    const payload = await $fetch<unknown>(CODEX_RADAR_URL, {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache'
      },
      timeout: 10_000,
      retry: 0
    })
    return parseCodexRadarPayload(payload)
  } catch (error) {
    throw createError({
      statusCode: 502,
      message: error instanceof Error && error.message.startsWith('CodexRadar ')
        ? error.message
        : '暂时无法连接 CodexRadar'
    })
  }
}
