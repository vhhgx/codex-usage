import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSub2ApiAccountQuota,
  parseSub2ApiAccountWindows
} from '../server/services/sub2api-admin'
import { parseSub2ApiOpenAiCallback } from '../server/services/sub2api-oauth'

afterEach(() => {
  vi.unstubAllGlobals()
})

function account() {
  return {
    upstreamId: 7,
    raw: {},
    view: {
      id: 'public-id',
      name: 'Test account',
      notes: null,
      platform: 'openai',
      accountType: 'oauth',
      status: 'active',
      schedulable: true,
      errorMessage: null,
      expiresAt: null,
      concurrency: 1,
      currentConcurrency: 0
    }
  } as Parameters<typeof fetchSub2ApiAccountQuota>[1]
}

function stubAdminFetch() {
  vi.stubGlobal('useRuntimeConfig', () => ({
    sub2apiBaseUrl: 'https://sub2api.example.com',
    sub2apiAdminApiKey: 'admin-key'
  }))
  const fetchMock = vi.fn().mockResolvedValue({
    code: 0,
    data: {
      five_hour: { utilization: 20 },
      updated_at: '2026-07-27T12:00:00+08:00'
    }
  })
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))
  return fetchMock
}

describe('Sub2API admin account quota parser', () => {
  it('combines account limits with Claude usage windows', () => {
    const result = parseSub2ApiAccountWindows({
      quota_limit: 100,
      quota_used: 25,
      quota_daily_limit: 20,
      quota_daily_used: 5,
      quota_daily_reset_at: '2026-07-22T00:00:00+08:00'
    }, {
      subscription_tier: 'max',
      five_hour: {
        utilization: 40,
        resets_at: '2026-07-21T23:00:00+08:00',
        window_stats: {
          requests: 42,
          tokens: 123456,
          cost: 1.25,
          standard_cost: 1.5,
          user_cost: 2
        }
      },
      seven_day: {
        utilization: 60,
        resets_at: '2026-07-28T00:00:00+08:00'
      }
    })

    expect(result.planType).toBe('max')
    expect(result.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'account-total', usedPercent: 25, remainingPercent: 75 }),
      expect.objectContaining({ id: 'account-daily', used: 5, limit: 20 }),
      expect.objectContaining({
        id: 'five_hour',
        remainingPercent: 60,
        stats: { requests: 42, tokens: 123456, cost: 1.25, standardCost: 1.5, userCost: 2 }
      }),
      expect.objectContaining({ id: 'seven_day', remainingPercent: 40 })
    ]))
  })

  it('maps Codex snapshots, Antigravity models, and Grok limits', () => {
    const result = parseSub2ApiAccountWindows({
      extra: {
        plan_type: 'plus',
        codex_5h_used_percent: 12,
        codex_5h_reset_at: '2026-07-21T18:00:00Z',
        codex_7d_used_percent: 35
      }
    }, {
      antigravity_quota: {
        'gemini-2.5-pro': { utilization: 18, reset_time: '2026-07-22T00:00:00Z' }
      },
      grok_request_quota: { limit: 1000, remaining: 800, reset_unix: 1_800_000_000 }
    })

    expect(result.planType).toBe('plus')
    expect(result.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex-5h', remainingPercent: 88 }),
      expect.objectContaining({ id: 'codex-7d', remainingPercent: 65 }),
      expect.objectContaining({ id: 'antigravity-gemini-2.5-pro', remainingPercent: 82 }),
      expect.objectContaining({ id: 'grok_request_quota', used: 200, limit: 1000, remainingPercent: 80 })
    ]))
  })

  it('prefers live Codex windows over duplicate account snapshots', () => {
    const result = parseSub2ApiAccountWindows({
      extra: {
        codex_5h_used_percent: 70,
        codex_7d_used_percent: 80
      }
    }, {
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 }
    })

    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', remainingPercent: 80 }),
      expect.objectContaining({ id: 'seven_day', remainingPercent: 70 })
    ])
  })

  it('reads the OpenAI plan from credentials when usage omits the tier', () => {
    const result = parseSub2ApiAccountWindows({
      credentials: {
        plan_type: 'k12',
        live_identity: { official_plan: 'plus' }
      },
      extra: { plan: 'plus' }
    }, {
      five_hour: { utilization: 10 }
    })

    expect(result.planType).toBe('k12')
  })

  it('preserves upstream usage errors without inventing quota windows', () => {
    const result = parseSub2ApiAccountWindows({}, { error: 'token expired' })
    expect(result.windows).toEqual([])
    expect(result.usageError).toBe('token expired')
  })
})

describe('Sub2API admin quota requests', () => {
  it('uses the upstream default source for passive account loading', async () => {
    const fetchMock = stubAdminFetch()

    await fetchSub2ApiAccountQuota({} as H3Event, account())

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://sub2api.example.com/api/v1/admin/accounts/7/usage')
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('query')
  })

  it('requests an active forced refresh when explicitly requested', async () => {
    const fetchMock = stubAdminFetch()

    await fetchSub2ApiAccountQuota({} as H3Event, account(), true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://sub2api.example.com/api/v1/admin/openai/accounts/7/quota/refresh',
      expect.objectContaining({ method: 'POST' })
    ])
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://sub2api.example.com/api/v1/admin/accounts/7/usage')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      query: { source: 'active', force: 'true' }
    })
  })

  it('does not query usage windows when the OpenAI quota probe fails', async () => {
    const fetchMock = stubAdminFetch()
    fetchMock.mockRejectedValueOnce({
      response: { status: 502 },
      data: {
        code: 502,
        message: 'upstream returned 402: {"detail":{"code":"deactivated_workspace"}}',
        reason: 'OPENAI_QUOTA_UPSTREAM_ERROR'
      }
    })

    await expect(fetchSub2ApiAccountQuota({} as H3Event, account(), true)).resolves.toMatchObject({
      quotaStatus: 'error',
      error: 'upstream returned 402: {"detail":{"code":"deactivated_workspace"}}',
      probeError: {
        code: 502,
        message: 'upstream returned 402: {"detail":{"code":"deactivated_workspace"}}',
        reason: 'OPENAI_QUOTA_UPSTREAM_ERROR'
      }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves an OpenAI account probe 401 instead of reporting a bad Sub2API management key', async () => {
    const fetchMock = stubAdminFetch()
    fetchMock.mockRejectedValueOnce({
      response: { status: 401 },
      data: {
        code: 401,
        message: 'upstream returned 401: {"detail":{"code":"invalid_token"}}',
        reason: 'OPENAI_QUOTA_UPSTREAM_ERROR'
      }
    })

    await expect(fetchSub2ApiAccountQuota({} as H3Event, account(), true)).resolves.toMatchObject({
      quotaStatus: 'error',
      error: 'upstream returned 401: {"detail":{"code":"invalid_token"}}',
      probeError: {
        code: 401,
        message: 'upstream returned 401: {"detail":{"code":"invalid_token"}}',
        reason: 'OPENAI_QUOTA_UPSTREAM_ERROR',
      }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('still reports actual Sub2API management authentication failures as configuration errors', async () => {
    const fetchMock = stubAdminFetch()
    fetchMock.mockRejectedValueOnce({
      response: { status: 401 },
      data: { code: 401, message: 'Authorization required', reason: 'UNAUTHORIZED' }
    })

    await expect(fetchSub2ApiAccountQuota({} as H3Event, account(), true)).rejects.toMatchObject({
      statusCode: 502,
      message: 'Sub2API 管理密钥无效或权限不足'
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('skips the OpenAI-only quota probe for other platforms', async () => {
    const fetchMock = stubAdminFetch()
    const nonOpenAi = account()
    nonOpenAi.view.platform = 'anthropic'

    await fetchSub2ApiAccountQuota({} as H3Event, nonOpenAi, true)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://sub2api.example.com/api/v1/admin/accounts/7/usage')
  })
})

describe('Sub2API OpenAI OAuth callback parsing', () => {
  it('extracts the one-time code and state from the official localhost callback', () => {
    const result = parseSub2ApiOpenAiCallback(
      'http://localhost:1455/auth/callback?code=code-value%2Fwith-symbols&state=abcdef0123456789'
    )
    expect(result).toEqual({
      code: 'code-value/with-symbols',
      state: 'abcdef0123456789'
    })
  })

  it('rejects callbacks outside the official localhost redirect and callbacks without state', () => {
    vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))
    expect(() => parseSub2ApiOpenAiCallback(
      'https://example.com/auth/callback?code=secret&state=abcdef0123456789'
    )).toThrow(/localhost:1455/)
    expect(() => parseSub2ApiOpenAiCallback(
      'http://localhost:1455/auth/callback?code=secret'
    )).toThrow(/OAuth state/)
  })
})
