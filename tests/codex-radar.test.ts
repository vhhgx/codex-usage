import { describe, expect, it } from 'vitest'
import { parseCodexRadarPayload } from '../shared/utils/codex-radar'

describe('CodexRadar parser', () => {
  it('maps the intelligence cards and upstream refresh time', () => {
    const result = parseCodexRadarPayload({
      model_iq: {
        latest: {
          score: 50,
          passed: 4,
          tasks: 12,
          cost_usd: 41.405896,
          wall_seconds: 1483,
          model: 'gpt-5.5',
          reasoning_effort: 'xhigh'
        },
        comparisons: {
          high: {
            latest: {
              score: 100,
              passed: 8,
              tasks: 12,
              cost_usd: 29.331065,
              wall_seconds: 1370,
              model: 'gpt-5.5',
              reasoning_effort: 'high'
            }
          },
          malformed: { latest: { score: 'invalid' } }
        },
        quota_radar: { updated_at: '2026-06-26T05:44:34Z' }
      }
    }, 1_800_000_000_000)

    expect(result.models).toHaveLength(2)
    expect(result.models[0]).toMatchObject({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      intelligenceScore: 50,
      passed: 4,
      tasks: 12,
      costUsd: 41.405896,
      wallSeconds: 1483
    })
    expect(result.models[1]).toMatchObject({
      reasoningEffort: 'high',
      intelligenceScore: 100
    })
    expect(result.updatedAt).toBe(Date.parse('2026-06-26T05:44:34Z'))
    expect(result.fetchedAt).toBe(1_800_000_000_000)
  })

  it('rejects payloads without usable model cards', () => {
    expect(() => parseCodexRadarPayload({ model_iq: { comparisons: {} } }))
      .toThrow('CodexRadar 没有可用的模型评分')
  })
})
