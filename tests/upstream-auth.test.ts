import { describe, expect, it, vi } from 'vitest'
import { isClientIdentityRejection, probeAuthSchemes, upstreamAuthHeaders } from '../server/utils/upstream-auth'

describe('upstream authentication compatibility', () => {
  it('keeps the configured scheme when it succeeds', async () => {
    const request = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const result = await probeAuthSchemes('x_api_key', request)
    expect(result).toMatchObject({ ok: true, selectedAuthScheme: 'x_api_key', changed: false })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('tries and selects the alternate scheme after an authentication failure', async () => {
    const request = vi.fn(async (scheme: 'bearer' | 'x_api_key') => scheme === 'bearer'
      ? { ok: false, status: 401, body: 'invalid authorization' }
      : { ok: true, status: 200, body: '{}' })
    const result = await probeAuthSchemes('bearer', request)
    expect(result).toMatchObject({ ok: true, selectedAuthScheme: 'x_api_key', changed: true })
    expect(request.mock.calls.map(call => call[0])).toEqual(['bearer', 'x_api_key'])
  })

  it('does not overwrite the configured scheme when both attempts fail', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 401, body: 'unauthorized' }))
    const result = await probeAuthSchemes('x_api_key', request)
    expect(result).toMatchObject({ ok: false, selectedAuthScheme: null, changed: false })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('recognizes client identity rejection separately from credential rejection', () => {
    expect(isClientIdentityRejection('{"type":"unauthorized_client_error","message":"unauthorized client detected"}')).toBe(true)
    expect(isClientIdentityRejection('{"message":"invalid api key"}')).toBe(false)
  })

  it('builds either Bearer or x-api-key headers without combining credentials', () => {
    expect(upstreamAuthHeaders('bearer', 'secret')).toEqual({ authorization: 'Bearer secret' })
    expect(upstreamAuthHeaders('x_api_key', 'secret')).toEqual({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' })
  })
})
