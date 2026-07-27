import { describe, expect, it } from 'vitest'
import { parseSub2ApiQuota, parseSub2ApiUsagePayload } from '../server/services/sub2api'

describe('Sub2API quota parser', () => {
  it('maps API key quota and rolling rate limits', () => {
    const result = parseSub2ApiQuota({
      mode: 'quota_limited',
      isValid: true,
      status: 'active',
      quota: { limit: 100, used: 35.5, remaining: 64.5, unit: 'USD' },
      rate_limits: [
        {
          window: '5h',
          limit: 20,
          used: 6,
          remaining: 14,
          reset_at: '2026-07-21T12:00:00Z'
        }
      ],
      expires_at: '2026-08-01T00:00:00Z',
      days_until_expiry: 10
    })

    expect(result).toMatchObject({
      mode: 'quota_limited',
      isValid: true,
      status: 'active',
      remaining: 64.5,
      unit: 'USD',
      daysUntilExpiry: 10
    })
    expect(result.limits).toEqual([
      expect.objectContaining({ id: 'total', label: '总额度', used: 35.5, limit: 100 }),
      expect.objectContaining({ id: 'rate-5h', label: '5 小时限额', remaining: 14 })
    ])
    expect(result.limits[1]?.resetAt).toBe(Date.parse('2026-07-21T12:00:00Z'))
  })

  it('maps subscription windows and expiry', () => {
    const result = parseSub2ApiQuota({
      mode: 'unrestricted',
      planName: 'Codex Weekly',
      remaining: 22,
      subscription: {
        daily_usage_usd: 3,
        daily_limit_usd: 10,
        weekly_usage_usd: 18,
        weekly_limit_usd: 40,
        monthly_usage_usd: 0,
        monthly_limit_usd: 0,
        expires_at: '2026-08-15T08:00:00+08:00'
      }
    })

    expect(result).toMatchObject({
      mode: 'subscription',
      planName: 'Codex Weekly',
      remaining: 22
    })
    expect(result.limits).toEqual([
      expect.objectContaining({ id: 'daily', used: 3, limit: 10, remaining: 7 }),
      expect.objectContaining({ id: 'weekly', used: 18, limit: 40, remaining: 22 })
    ])
    expect(result.expiresAt).toBe(Date.parse('2026-08-15T08:00:00+08:00'))
  })

  it('maps wallet balances without manufacturing limits', () => {
    expect(parseSub2ApiQuota({
      mode: 'unrestricted',
      planName: '钱包余额',
      remaining: 12.75,
      balance: 12.75
    })).toMatchObject({
      mode: 'balance',
      balance: 12.75,
      remaining: 12.75,
      limits: []
    })
  })
})

describe('Sub2API usage parser', () => {
  it('aggregates daily totals and maps per-model token details', () => {
    const now = new Date('2026-07-21T10:00:00+08:00')
    const result = parseSub2ApiUsagePayload({
      mode: 'unrestricted',
      balance: 9,
      remaining: 9,
      usage: { average_duration_ms: 1234 },
      daily_usage: [
        {
          date: '2026-07-20',
          requests: 2,
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 10,
          cache_write_tokens: 5,
          total_tokens: 170,
          actual_cost: 0.4
        },
        {
          date: '2026-07-21',
          requests: 3,
          input_tokens: 200,
          output_tokens: 80,
          cache_read_tokens: 20,
          cache_write_tokens: 5,
          total_tokens: 300,
          actual_cost: 0.6
        }
      ],
      model_stats: [
        {
          model: 'gpt-5.3-codex',
          requests: 5,
          input_tokens: 300,
          output_tokens: 130,
          cache_creation_tokens: 10,
          cache_read_tokens: 30,
          total_tokens: 470,
          actual_cost: 1
        }
      ]
    }, '7d', now)

    expect(result.source).toBe('sub2api')
    expect(result.summary).toMatchObject({
      calls: 5,
      inputTokens: 300,
      outputTokens: 130,
      cachedTokens: 40,
      totalTokens: 470,
      estimatedCost: 1,
      averageLatencyMs: 1234,
      successRate: null
    })
    expect(result.timeline).toHaveLength(2)
    expect(result.models[0]).toMatchObject({
      model: 'gpt-5.3-codex',
      calls: 5,
      successRate: null,
      totalTokens: 470
    })
    expect(result.quota?.mode).toBe('balance')
  })
})
