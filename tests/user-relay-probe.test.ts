import { describe, expect, it } from 'vitest'
import { interpretRelayCheckinResponse, newApiBalanceQuotaValues, normalizeUserRelayOrder } from '../server/services/user-relays'
import { parseChannelProtocols } from '../server/services/hub-admin'
import { mergeUserFailoverSourceIds } from '../server/services/user-route-preferences'

describe('private relay protocol settings', () => {
  it('preserves the probe model explicitly selected for each protocol', () => {
    expect(parseChannelProtocols([
      { protocol: 'anthropic_messages', probeModel: 'claude-sonnet-4-6' },
      { protocol: 'openai_responses', probeModel: 'gpt-5.6-codex' }
    ], 'openai_compatible')).toMatchObject([
      { protocol: 'anthropic_messages', probeModel: 'claude-sonnet-4-6' },
      { protocol: 'openai_responses', probeModel: 'gpt-5.6-codex' }
    ])
  })

  it('accepts only a complete, unique relay order', () => {
    expect(normalizeUserRelayOrder(['relay-a', 'relay-b'], ['relay-b', 'relay-a'])).toEqual(['relay-b', 'relay-a'])
    expect(() => normalizeUserRelayOrder(['relay-a', 'relay-b'], ['relay-a'])).toThrowError(/列表已发生变化/)
    expect(() => normalizeUserRelayOrder(['relay-a', 'relay-b'], ['relay-a', 'relay-a'])).toThrowError(/列表已发生变化/)
    expect(() => normalizeUserRelayOrder(['relay-a', 'relay-b'], ['relay-a', 'relay-c'])).toThrowError(/列表已发生变化/)
  })

  it('keeps saved sources and appends newly available relays', () => {
    expect(mergeUserFailoverSourceIds(['relay:b', 'package', 'relay:removed'], ['a', 'b'])).toEqual(['relay:b', 'package', 'relay:a'])
  })

  it('adds a provisioned private pool as a draggable failover source', () => {
    expect(mergeUserFailoverSourceIds(['relay:b', 'package'], ['a', 'b'], true, true)).toEqual(['relay:b', 'package', 'relay:a', 'private_pool'])
  })

  it('understands current and legacy NewAPI check-in responses', () => {
    expect(interpretRelayCheckinResponse(200, { success: true, message: '签到成功', data: { quota_awarded: 500 } })).toMatchObject({ status: 'success', awardedQuota: 500 })
    expect(interpretRelayCheckinResponse(200, { success: false, message: '今日已签到' })).toMatchObject({ status: 'already' })
    expect(interpretRelayCheckinResponse(404, { message: 'not found' })).toMatchObject({ status: 'unsupported' })
  })

  it('adds purchased and gifted NewAPI balances without double-counting official responses', () => {
    expect(newApiBalanceQuotaValues({ quota: 104_581_130, gift_quota: 10_378_122, total_quota: 114_959_252, used_quota: 1_451_688_924 })).toEqual({
      quota: 114_959_252,
      purchasedQuota: 104_581_130,
      giftQuota: 10_378_122,
      usedQuota: 1_451_688_924
    })
    expect(newApiBalanceQuotaValues({ quota: 100, gift_quota: 20 })).toMatchObject({ quota: 120 })
    expect(newApiBalanceQuotaValues({ quota: 100, used_quota: 25 })).toMatchObject({ quota: 100, giftQuota: null, usedQuota: 25 })
  })
})
