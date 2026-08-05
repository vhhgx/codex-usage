import { afterEach, describe, expect, it, vi } from 'vitest'
import { trustedClientIp } from '../server/utils/client-ip'

function event(remoteAddress: string, forwardedFor?: string) {
  return {
    node: {
      req: {
        socket: { remoteAddress },
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}
      }
    }
  } as never
}

afterEach(() => vi.unstubAllGlobals())

describe('trusted client IP', () => {
  it('ignores forwarded headers from public clients', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ trustedProxyCidrs: '10.20.0.1/32' }))
    expect(trustedClientIp(event('203.0.113.8', '198.51.100.4'))).toBe('203.0.113.8')
  })

  it('accepts a valid address from a configured proxy subnet', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ trustedProxyCidrs: '10.20.0.0/24,2001:db8::/64' }))
    expect(trustedClientIp(event('10.20.0.1', '198.51.100.4'))).toBe('198.51.100.4')
    expect(trustedClientIp(event('2001:db8::1', '2001:db8:1::9'))).toBe('2001:db8:1::9')
  })

  it('falls back to the direct peer for malformed forwarded values', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ trustedProxyCidrs: '127.0.0.1,10.20.0.1/32' }))
    expect(trustedClientIp(event('::ffff:10.20.0.1', 'spoofed-value'))).toBe('10.20.0.1')
  })
})
