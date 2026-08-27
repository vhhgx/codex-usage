import { describe, expect, it } from 'vitest'
import {
  CODEX_RADAR_INTELLIGENCE_URL,
  CODEX_RADAR_URL,
  parseCodexRadarPayload
} from '../shared/utils/codex-radar'
import { selectRadarEffort } from '../server/services/codex-radar'

describe('CodexRadar parser', () => {
  it('maps the intelligence cards and upstream refresh time', () => {
    const result = parseCodexRadarPayload({
      model_iq: {
        updated_at: '2026-07-28T09:14:16+08:00',
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
    expect(result.updatedAt).toBe(Date.parse('2026-07-28T09:14:16+08:00'))
    expect(result.fetchedAt).toBe(1_800_000_000_000)
    expect(result.sourceUrl).toBe(CODEX_RADAR_URL)
  })

  it('maps every model and effort from the intelligence efficiency points', () => {
    const result = parseCodexRadarPayload({
      source_updated_at: '2026-07-28T10:52:40+08:00',
      points: [
        {
          model: 'gpt-5.6-sol',
          effort: 'ultra',
          iq: 95.0893,
          passed: 71,
          valid_tasks: 112,
          average_price_usd: 25.363212,
          average_minutes: 60.5723
        },
        {
          model: 'gpt-future',
          effort: 'adaptive',
          iq: 88.5,
          passed: 59,
          valid_tasks: 100,
          average_price_usd: 6.25,
          average_minutes: 24.5
        },
        { model: 'malformed' }
      ]
    }, 1_800_000_000_001)

    expect(result.models).toHaveLength(2)
    expect(result.models[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      intelligenceScore: 95.0893,
      passed: 71,
      tasks: 112,
      costUsd: 25.363212
    })
    expect(result.models[0]?.wallSeconds).toBeCloseTo(3634.338)
    expect(result.models[1]).toMatchObject({
      model: 'gpt-future',
      reasoningEffort: 'adaptive'
    })
    expect(result.updatedAt).toBe(Date.parse('2026-07-28T10:52:40+08:00'))
    expect(result.fetchedAt).toBe(1_800_000_000_001)
    expect(result.sourceUrl).toBe(CODEX_RADAR_INTELLIGENCE_URL)
  })

  it('rejects payloads without usable model cards', () => {
    expect(() => parseCodexRadarPayload({ model_iq: { comparisons: {} } }))
      .toThrow('CodexRadar 没有可用的模型评分')
    expect(() => parseCodexRadarPayload({ points: [{ model: 'malformed' }] }))
      .toThrow('CodexRadar 没有可用的模型评分')
  })

  it('selects the highest intelligence score within the configured effort ceiling', () => {
    const radar = { models: [
      { id: '1', model: 'gpt-5.6-sol', reasoningEffort: 'medium', intelligenceScore: 91, passed: 1, tasks: 1, costUsd: 1, wallSeconds: 1 },
      { id: '2', model: 'gpt-5.6-sol', reasoningEffort: 'high', intelligenceScore: 95, passed: 1, tasks: 1, costUsd: 1, wallSeconds: 1 },
      { id: '3', model: 'gpt-5.6-sol', reasoningEffort: 'max', intelligenceScore: 99, passed: 1, tasks: 1, costUsd: 1, wallSeconds: 1 }
    ], updatedAt: null, fetchedAt: 1, sourceUrl: 'test' }
    expect(selectRadarEffort(radar, 'openai/gpt-5.6-sol', 'high')).toBe('high')
    expect(selectRadarEffort(radar, 'gpt-5.6-sol', 'medium')).toBe('medium')
    expect(selectRadarEffort(radar, 'glm-5.3', 'max')).toBeNull()
  })
})
