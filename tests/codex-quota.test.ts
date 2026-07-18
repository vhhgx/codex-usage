import { describe, expect, it } from 'vitest'
import { parseQuotaPayload } from '../server/services/cpa'

describe('Codex quota parser', () => {
  it('classifies five-hour and weekly windows', () => {
    const result = parseQuotaPayload({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 23.5,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000
        },
        secondary_window: {
          used_percent: 61,
          limit_window_seconds: 604_800,
          reset_after_seconds: 3600
        }
      }
    })

    expect(result.planType).toBe('plus')
    expect(result.windows).toHaveLength(2)
    expect(result.windows[0]).toMatchObject({
      kind: 'five-hour',
      usedPercent: 23.5,
      remainingPercent: 76.5
    })
    expect(result.windows[1]).toMatchObject({
      kind: 'weekly',
      usedPercent: 61,
      remainingPercent: 39
    })
  })

  it('shows exhausted windows as fully used when the provider omits percentage', () => {
    const result = parseQuotaPayload({
      rate_limit: {
        limit_reached: true,
        primary_window: { limit_window_seconds: 18_000, reset_after_seconds: 600 }
      }
    })

    expect(result.windows[0]).toMatchObject({ usedPercent: 100, remainingPercent: 0 })
  })
})
