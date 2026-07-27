import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSub2ApiAccountQuota,
  parseSub2ApiAccountWindows
} from '../server/services/sub2api-admin'

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
        resets_at: '2026-07-21T23:00:00+08:00'
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
      expect.objectContaining({ id: 'five_hour', remainingPercent: 60 }),
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

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      query: { source: 'active', force: 'true' }
    })
  })
})
