import { describe, expect, it } from 'vitest'
import { MAX_UPSTREAM_RETRIES, shouldRetryUpstream, shouldRetryUpstreamError, upstreamRetryDelay } from '../server/services/upstream-retry'

describe('upstream retry policy', () => {
  it('retries rate limits and temporary upstream failures', () => {
    for (const status of [429, 500, 502, 503, 504]) expect(shouldRetryUpstream(status)).toBe(true)
    expect(shouldRetryUpstream(400, '{"error":{"type":"overloaded_error"}}')).toBe(true)
    expect(shouldRetryUpstream(400, 'server_overloaded')).toBe(true)
    expect(shouldRetryUpstream(400, 'temporarily unavailable')).toBe(true)
  })

  it('does not retry permanent request or authentication failures', () => {
    expect(shouldRetryUpstream(400, 'invalid request')).toBe(false)
    expect(shouldRetryUpstream(401, 'invalid api key')).toBe(false)
    expect(shouldRetryUpstream(404, 'model not found')).toBe(false)
    expect(MAX_UPSTREAM_RETRIES).toBe(2)
  })

  it('retries transient network failures but not DNS or certificate errors', () => {
    expect(shouldRetryUpstreamError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true)
    expect(shouldRetryUpstreamError(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(true)
    expect(shouldRetryUpstreamError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } }))).toBe(false)
    expect(shouldRetryUpstreamError(Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } }))).toBe(false)
  })

  it('uses bounded exponential backoff and honors Retry-After', () => {
    expect(upstreamRetryDelay(null, 0, () => 0)).toBe(250)
    expect(upstreamRetryDelay(null, 1, () => 0)).toBe(500)
    expect(upstreamRetryDelay('1.5', 0, () => 0)).toBe(1500)
    expect(upstreamRetryDelay('30', 0, () => 0)).toBe(2000)
  })
})
