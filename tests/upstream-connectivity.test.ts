import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ baseFetch: vi.fn(), close: vi.fn() }))

vi.mock('../server/utils/upstream-url', () => ({
  pinnedUpstreamBaseFetch: mocks.baseFetch,
  upstreamNetworkError: (error: { code?: string; message?: string }) => ({
    code: error.code || 'UPSTREAM_FETCH_FAILED',
    message: error.message || '上游连接失败'
  })
}))

import { connectivityFailureAllowsRetry, connectivityStatus, probeUpstreamConnectivity } from '../server/services/upstream-connectivity'

afterEach(() => vi.clearAllMocks())

describe('platform-independent upstream connectivity', () => {
  it('treats any HTTP response as reachable without authentication', async () => {
    mocks.baseFetch.mockResolvedValue({ response: { status: 401 }, target: 'https://relay.test/v1', close: mocks.close })

    const result = await probeUpstreamConnectivity('https://relay.test/v1')

    expect(result).toMatchObject({ status: 'operational', success: true, httpStatus: 401, retryCount: 0 })
    expect(mocks.baseFetch).toHaveBeenCalledWith('https://relay.test/v1', expect.objectContaining({
      method: 'GET',
      headers: { accept: '*/*', 'accept-encoding': 'identity' }
    }))
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('retries timeout failures once but does not retry DNS failures', async () => {
    mocks.baseFetch
      .mockRejectedValueOnce(Object.assign(new Error('Request timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
      .mockResolvedValueOnce({ response: { status: 404 }, target: 'https://relay.test', close: mocks.close })

    await expect(probeUpstreamConnectivity('https://relay.test')).resolves.toMatchObject({ success: true, httpStatus: 404, retryCount: 1 })
    expect(mocks.baseFetch).toHaveBeenCalledTimes(2)

    mocks.baseFetch.mockReset()
    mocks.baseFetch.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
    await expect(probeUpstreamConnectivity('https://missing.test')).resolves.toMatchObject({ success: false, errorCode: 'ENOTFOUND', retryCount: 0 })
    expect(mocks.baseFetch).toHaveBeenCalledOnce()
  })

  it('uses TTFB thresholds without conflating reachability with health', () => {
    expect(connectivityStatus(6_000)).toBe('operational')
    expect(connectivityStatus(6_001)).toBe('degraded')
    expect(connectivityFailureAllowsRetry('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error')).toBe(true)
    expect(connectivityFailureAllowsRetry('ENOTFOUND', 'DNS failed')).toBe(false)
  })
})
