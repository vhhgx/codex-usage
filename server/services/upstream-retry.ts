const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const OVERLOAD_PATTERN = /overloaded[_ -]?error|server[_ -]?overloaded|temporarily[_ -]?unavailable|service[_ -]?overload|server is (?:currently )?overloaded|capacity (?:is )?(?:temporarily )?(?:exhausted|unavailable)/i

export const MAX_UPSTREAM_RETRIES = 2

export function shouldRetryUpstream(status: number | null, body = '') {
  return status !== null && RETRYABLE_STATUSES.has(status) || OVERLOAD_PATTERN.test(body)
}

export function shouldRetryUpstreamError(error: unknown) {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } }
  const detail = `${value?.name || ''} ${value?.code || ''} ${value?.message || ''} ${value?.cause?.code || ''} ${value?.cause?.message || ''}`
  if (/enotfound|cert_|certificate|self signed|unable to verify|hostname\/ip does not match/i.test(detail)) return false
  return /timeout|timed out|aborterror|econnreset|econnrefused|ehostunreach|enetunreach|socket.*closed|other side closed|fetch failed/i.test(detail)
}

export function upstreamRetryDelay(retryAfter: string | null, retryIndex: number, random = Math.random) {
  let retryAfterMs = 0
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds * 1000)
    else {
      const at = Date.parse(retryAfter)
      if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - Date.now())
    }
  }
  const exponentialMs = 250 * 2 ** Math.max(0, retryIndex)
  const jitterMs = Math.floor(Math.max(0, Math.min(1, random())) * 150)
  return Math.min(2_000, Math.max(retryAfterMs, exponentialMs + jitterMs))
}

export function waitForUpstreamRetry(delayMs: number) {
  return new Promise<void>(resolve => setTimeout(resolve, delayMs))
}
