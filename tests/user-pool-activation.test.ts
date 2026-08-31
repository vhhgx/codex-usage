import { describe, expect, it, vi } from 'vitest'
import { verifyAndEnableUserPoolAccounts } from '../shared/utils/user-pool-activation'

describe('imported user pool account activation', () => {
  it('verifies each imported account before enabling scheduling', async () => {
    const request = vi.fn(async () => undefined)

    const result = await verifyAndEnableUserPoolAccounts(['account/1'], request)

    expect(request.mock.calls).toEqual([
      ['/api/console/pool/accounts/account%2F1/verify', { method: 'POST' }],
      ['/api/console/pool/accounts/account%2F1', { method: 'PATCH', body: { schedulable: true } }]
    ])
    expect(result).toEqual([{ accountId: 'account/1', enabled: true }])
  })

  it('keeps an account disabled when verification fails', async () => {
    const failure = new Error('invalid credentials')
    const request = vi.fn(async () => { throw failure })

    const result = await verifyAndEnableUserPoolAccounts(['account-1'], request)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('/api/console/pool/accounts/account-1/verify', { method: 'POST' })
    expect(result).toEqual([{ accountId: 'account-1', enabled: false, error: failure }])
  })
})
