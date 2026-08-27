import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn()
}))

vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('undici', () => {
  class Agent {
    address = ''
    family = 0
    constructor(options: { connect: { lookup: (host: string, options: { all: boolean }, callback: (error: null, addresses: Array<{ address: string; family: number }>) => void) => void } }) {
      options.connect.lookup('relay.test', { all: true }, (_error, addresses) => {
        this.address = addresses[0]?.address || ''
        this.family = addresses[0]?.family || 0
      })
    }
    close() { return Promise.resolve() }
  }
  return { Agent, fetch: mocks.fetch }
})

import { isPublicUpstreamAddress, isTunFakeIpAddress, normalizeUserUpstreamUrl, pinnedUpstreamBaseFetch, pinnedUpstreamFetch, upstreamNetworkError, upstreamTarget } from '../server/utils/upstream-url'

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.NUXT_ALLOW_TUN_FAKE_IP_UPSTREAMS
})

describe('private relay SSRF protection', () => {
  it('accepts clean HTTP and HTTPS base URLs', () => {
    expect(normalizeUserUpstreamUrl('https://relay.example.com/v1/')).toBe('https://relay.example.com/v1')
    expect(normalizeUserUpstreamUrl('http://relay.example.com')).toBe('http://relay.example.com')
    expect(() => normalizeUserUpstreamUrl('https://user:pass@relay.example.com')).toThrow('不能包含凭据')
    expect(() => normalizeUserUpstreamUrl('https://relay.example.com?target=x')).toThrow('不能包含凭据')
  })

  it('blocks local, private, metadata and reserved IP ranges', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicUpstreamAddress(address), address).toBe(false)
    }
    expect(isPublicUpstreamAddress('1.1.1.1')).toBe(true)
    expect(isPublicUpstreamAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('recognizes only the benchmark range used by TUN fake-IP DNS', () => {
    expect(isTunFakeIpAddress('198.18.0.1')).toBe(true)
    expect(isTunFakeIpAddress('198.19.255.254')).toBe(true)
    expect(isTunFakeIpAddress('198.20.0.1')).toBe(false)
    expect(isTunFakeIpAddress('192.168.1.1')).toBe(false)
  })
})

describe('upstream endpoint joining', () => {
  it('keeps the canonical v1 prefix for an unversioned base URL', () => {
    expect(upstreamTarget('https://relay.example.com', '/v1/chat/completions')).toBe('https://relay.example.com/v1/chat/completions')
  })

  it('does not duplicate the version segment for versioned base URLs', () => {
    expect(upstreamTarget('https://relay.example.com/v1', '/v1/models')).toBe('https://relay.example.com/v1/models')
    expect(upstreamTarget('https://open.bigmodel.cn/api/paas/v4', '/v1/chat/completions')).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(upstreamTarget('https://open.bigmodel.cn/api/paas/v4', '/v1/models')).toBe('https://open.bigmodel.cn/api/paas/v4/models')
  })

  it('preserves v1 below a non-versioned API namespace', () => {
    expect(upstreamTarget('https://open.bigmodel.cn/api/anthropic', '/v1/messages')).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
  })
})

describe('pinned upstream fetch', () => {
  it('falls back to the next validated DNS address after a connection failure', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '8.8.8.8', family: 4 }
    ])
    const response = { ok: true, status: 200 }
    mocks.fetch.mockImplementation(async (_target, options) => {
      const address = (options.dispatcher as { address: string }).address
      if (address === '1.1.1.1') {
        const cause = Object.assign(new Error('connect ECONNREFUSED 1.1.1.1:443'), { code: 'ECONNREFUSED', syscall: 'connect' })
        throw Object.assign(new TypeError('fetch failed'), { cause })
      }
      return response
    })

    const result = await pinnedUpstreamFetch('https://relay.test/v1', '/v1/models')

    expect(result.address).toBe('8.8.8.8')
    expect(result.target).toBe('https://relay.test/v1/models')
    expect(result.response).toBe(response)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('allows hostname fake-IP addresses only with the explicit local TUN switch', async () => {
    process.env.NUXT_ALLOW_TUN_FAKE_IP_UPSTREAMS = 'true'
    mocks.lookup.mockResolvedValue([{ address: '198.18.0.11', family: 4 }])
    const response = { ok: true, status: 200 }
    mocks.fetch.mockResolvedValue(response)

    const result = await pinnedUpstreamFetch('https://relay.test', '/v1/models')

    expect(result.address).toBe('198.18.0.11')
    expect(result.response).toBe(response)
  })

  it('probes the configured base URL without rewriting its path', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
    const response = { ok: false, status: 401 }
    mocks.fetch.mockResolvedValue(response)

    const result = await pinnedUpstreamBaseFetch('https://relay.test/custom/v1')

    expect(result.target).toBe('https://relay.test/custom/v1')
    expect(result.response).toBe(response)
  })

  it('expands the useful cause and code hidden behind fetch failed', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND relay.test'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' })
    const detail = upstreamNetworkError(Object.assign(new TypeError('fetch failed'), { cause }))
    expect(detail.code).toBe('ENOTFOUND')
    expect(detail.message).toContain('getaddrinfo ENOTFOUND relay.test')
    expect(detail.message).not.toBe('fetch failed')
  })
})
