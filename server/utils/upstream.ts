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

const SENSITIVE_FIELD = /^(?:authorization|proxy[-_]?authorization|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session(?:[-_]?token)?|setup[-_]?token|token|password|passwd|secret|secret[-_]?key|credential|credentials|cookie|private[-_]?key|client[-_]?secret)$/i

/**
 * Redact secrets in free-form upstream text before it is persisted or shown
 * to a client. The optional limit lets callers keep a useful diagnostic
 * length while retaining the historical 500-character default.
 */
export function redactSensitiveText(value: unknown, limit = 500) {
  const max = Math.max(0, Number.isFinite(limit) ? limit : 500)
  return String(value || '')
    .slice(0, Math.max(2000, max))
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@/\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization|proxy[-_]?authorization)\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+\/-]+/gi, '$1: [REDACTED]')
    .replace(/["']?(?:authorization|proxy[-_]?authorization|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session(?:[-_]?token)?|setup[-_]?token|token|password|passwd|secret|credential|cookie|private[-_]?key|client[-_]?secret)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}]+)/gi, match => match.replace(/([:=]\s*).+$/s, '$1[REDACTED]'))
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|zh)-[A-Za-z0-9._~+\/-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[REDACTED_TOKEN]')
    .slice(0, max)
}

/** Recursively redact JSON payloads while preserving their response shape. */
export function redactSensitivePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redactSensitivePayload(item))
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSensitiveText(value) : value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactSensitivePayload(item)
  ]))
}
