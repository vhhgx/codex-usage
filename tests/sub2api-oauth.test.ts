import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const redis = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn()
}))

vi.mock('../server/utils/redis', () => ({ useRedis: () => redis }))

import {
  completeManagedSub2ApiOpenAiOAuth,
  startManagedSub2ApiOpenAiOAuth
} from '../server/services/sub2api-oauth'

const event = {} as H3Event
const config = {
  sub2apiBaseUrl: 'http://sub.test',
  sub2apiAdminApiKey: 'admin-secret',
  accountIdSecret: 'a'.repeat(32)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Sub2API OpenAI OAuth flow', () => {
  it('stores the upstream session server-side and returns only a random Hub flow ID', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ code: 0, data: {
      auth_url: 'https://auth.openai.com/oauth/authorize?client_id=test&state=upstream-state',
      session_id: 'upstream-session-id'
    } })
    redis.set.mockResolvedValueOnce('OK')
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)

    const result = await startManagedSub2ApiOpenAiOAuth(event, {
      adminId: 'admin-1',
      proxyId: null,
      useDefaultProxy: false,
      accountVaultId: 'vault-account-1'
    })

    expect(result.authorizationUrl).toContain('https://auth.openai.com/oauth/authorize')
    expect(result.flowId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.flowId).not.toContain('upstream-session-id')
    expect(fetch).toHaveBeenCalledWith('http://sub.test/api/v1/admin/openai/generate-auth-url', expect.objectContaining({
      method: 'POST', body: {}
    }))
    const stored = JSON.parse(String(redis.set.mock.calls[0]?.[1]))
    expect(stored).toMatchObject({ adminId: 'admin-1', sessionId: 'upstream-session-id', proxyId: null, accountVaultId: 'vault-account-1' })
    expect(JSON.stringify(stored)).not.toContain('auth.openai.com')
  })

  it('submits the callback to Sub2API, creates the account, and consumes the Hub flow', async () => {
    const flowId = 'f'.repeat(43)
    redis.set.mockResolvedValueOnce('OK')
    redis.get.mockResolvedValueOnce(JSON.stringify({
      adminId: 'admin-1',
      sessionId: 'upstream-session-id',
      proxyId: null,
      accountVaultId: 'vault-account-1',
      expiresAt: Date.now() + 60_000
    }))
    redis.del.mockResolvedValue(1)
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { items: [], pages: 1 } })
      .mockResolvedValueOnce({ code: 0, data: {
        id: 43, name: 'oauth@example.com', platform: 'openai', type: 'oauth',
        status: 'active', schedulable: true, concurrency: 10, priority: 0, group_ids: []
      } })
      .mockResolvedValueOnce({ code: 0, data: {
        id: 43, name: 'oauth@example.com', platform: 'openai', type: 'oauth',
        status: 'active', schedulable: true, concurrency: 10, priority: 0, group_ids: []
      } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)

    const account = await completeManagedSub2ApiOpenAiOAuth(event, 'admin-1', {
      flowId,
      callbackUrl: 'http://localhost:1455/auth/callback?code=one-time-code&state=oauth-state',
      name: '',
      concurrency: 10,
      priority: 0,
      groupIds: [],
      schedulable: true,
      accountVaultId: 'vault-account-1'
    })

    expect(account).toMatchObject({ name: 'oauth@example.com', platform: 'openai', schedulable: true })
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://sub.test/api/v1/admin/openai/create-from-oauth', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        session_id: 'upstream-session-id',
        code: 'one-time-code',
        state: 'oauth-state'
      })
    }))
    expect(redis.del).toHaveBeenCalledTimes(2)
  })
})
