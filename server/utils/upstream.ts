import type { H3Event } from 'h3'

export function normalizeBaseUrl(value: unknown) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function requireUpstreamConfig(
  event: H3Event,
  keys: Array<
    | 'cpaBaseUrl'
    | 'cpaManagementKey'
    | 'cpampBaseUrl'
    | 'cpampAdminKey'
    | 'sub2apiBaseUrl'
    | 'sub2apiAdminApiKey'
  >
) {
  const config = useRuntimeConfig(event)
  for (const key of keys) {
    if (!String(config[key] || '').trim()) {
      throw createError({
        statusCode: 503,
        message: `服务端未配置 ${key}`
      })
    }
  }
  return config
}

export function upstreamError(error: unknown, fallback: string): never {
  const status = Number((error as { response?: { status?: number } })?.response?.status || 0)
  const data = (error as { data?: unknown })?.data
  const message =
    typeof data === 'object' && data && 'error' in data && typeof data.error === 'string'
      ? data.error
      : error instanceof Error
        ? error.message
        : fallback

  throw createError({
    statusCode: status >= 400 && status < 600 ? status : 502,
    message: message || fallback
  })
}
