import { describe, expect, it, vi } from 'vitest'
import { activityLogQuery } from '../shared/utils/admin-log-query'
import { scheduleActivityRefresh } from '../shared/utils/activity-refresh'
import {
  buildKeyActivityResponse,
  isKeyActivityRequest,
  keyActivityRange
} from '../server/services/key-activity'

describe('key activity', () => {
  it('uses the configured timezone for day boundaries', () => {
    const range = keyActivityRange('2026-07-29', 'Asia/Shanghai')
    expect(range.from.toISOString()).toBe('2026-07-28T16:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-07-29T16:00:00.000Z')
    expect(() => keyActivityRange('2026-02-30', 'Asia/Shanghai')).toThrow('Invalid date key')
  })

  it('returns all existing keys and fills all 24 hourly buckets', () => {
    const from = Date.parse('2026-07-28T16:00:00.000Z')
    const generatedAt = Date.parse('2026-07-29T03:42:00.000Z')
    const response = buildKeyActivityResponse({
      timezone: 'Asia/Shanghai',
      dateKey: '2026-07-29',
      from,
      to: Date.parse('2026-07-29T16:00:00.000Z'),
      generatedAt,
      keys: [
        { id: 'active', name: 'Active', maskedKey: 'zh-active...0001', status: 'active' },
        { id: 'disabled', name: 'Disabled', maskedKey: 'zh-disabled...0002', status: 'disabled' },
        { id: 'expired', name: 'Expired', maskedKey: 'zh-expired...0003', status: 'expired' }
      ],
      rows: [{
        keyId: 'active', slot: 11, requests: 4, successes: 1, failures: 2, pending: 1,
        tokens: 120, cost: 0.25, lastSeenAt: generatedAt - 60_000
      }]
    })

    expect(response.keys).toHaveLength(3)
    expect(response.keys.every(key => key.buckets.length === 24)).toBe(true)
    expect(response.keys[0]?.buckets[11]).toMatchObject({ requests: 4, tokens: 120, cost: 0.25, failures: 2 })
    expect(response.keys[0]?.buckets[10]?.requests).toBe(0)
    expect(response.keys[0]).toMatchObject({ requests: 4, successes: 1, failures: 2, pending: 1, recentlyActive: true })
    expect(response.keys[1]).toMatchObject({ requests: 0, recentlyActive: false, status: 'disabled' })
    expect(response.activeCount).toBe(1)
    expect(response.recentlyActiveCount).toBe(1)
  })

  it('uses 23 and 25 real hourly buckets on daylight-saving transition days', () => {
    const spring = keyActivityRange('2026-03-08', 'America/Los_Angeles')
    const fall = keyActivityRange('2026-11-01', 'America/Los_Angeles')
    const response = (from: Date, to: Date) => buildKeyActivityResponse({
      timezone: 'America/Los_Angeles', dateKey: 'unused', from: from.getTime(), to: to.getTime(),
      generatedAt: from.getTime(), keys: [], rows: []
    })
    expect(response(spring.from, spring.to).buckets).toHaveLength(23)
    expect(response(fall.from, fall.to).buckets).toHaveLength(25)
  })

  it('counts authenticated business requests but excludes model discovery', () => {
    expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/chat/completions', status: 'success' })).toBe(true)
    expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/responses', status: 'error' })).toBe(true)
    expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/responses', status: 'stream_aborted' })).toBe(true)
    expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/responses', status: 'pending' })).toBe(true)
    expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/models', status: 'success' })).toBe(false)
    expect(isKeyActivityRequest({ keyId: null, endpoint: '/v1/responses', status: 'error' })).toBe(false)
  })

  it('creates an exact one-hour request-log filter', () => {
    const timestamp = Date.parse('2026-07-29T03:00:00.000Z')
    expect(activityLogQuery('key-id', timestamp)).toEqual({
      keyId: 'key-id',
      from: '2026-07-29T03:00:00.000Z',
      to: '2026-07-29T04:00:00.000Z'
    })
  })

  it('stops automatic refreshes after the page is disposed', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = scheduleActivityRefresh(refresh)
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
