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
  const rawMessage =
    typeof data === 'object' && data && 'error' in data && typeof data.error === 'string'
      ? data.error
      : error instanceof Error
        ? error.message
        : fallback

  const message = redactSensitiveText(rawMessage || fallback)
  const ambiguous = !status && /timeout|timed out|abort|socket|network|fetch failed/i.test(String(rawMessage || ''))
  throw createError({
    statusCode: status >= 400 && status < 600 ? status : 502,
    message: message || fallback,
    data: ambiguous ? { reconciliationRequired: true } : undefined
  })
}

export function redactSensitiveText(value: unknown) {
  return String(value || '')
    .slice(0, 2000)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@/\s]+@/gi, '$1[REDACTED]@')
    .replace(/("?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|cookie|private[_-]?key)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 500)
}
