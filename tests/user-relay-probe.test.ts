import { describe, expect, it } from 'vitest'
import { interpretRelayCheckinResponse, newApiBalanceQuotaValues, normalizeUserRelayOrder, preferredModelDiscoveryProtocol, sortRelayAccounts } from '../server/services/user-relays'
import { parseChannelProtocols, resolveChannelModelBindingUpstreamModel } from '../server/services/hub-admin'
import { relayPresetCapabilityMode, relayProviderPresets } from '../shared/relay-provider-presets'
import { mergeUserFailoverSourceIds } from '../server/services/user-route-preferences'
import { classifyRelayFailure, relayFailureAffectsAccount, relayFailureAllowsFailover } from '../server/services/relay-platform'

describe('private relay protocol settings', () => {
  it('marks Chat-only official presets as Responses-to-Chat capable', () => {
    const deepseek = relayProviderPresets.find(preset => preset.id === 'deepseek')!
    expect(relayPresetCapabilityMode(deepseek, 'openai_chat')).toBe('responses_via_chat')
    expect(relayPresetCapabilityMode(deepseek, 'anthropic_messages')).toBe('native')
    const openai = relayProviderPresets.find(preset => preset.id === 'openai')!
    expect(relayPresetCapabilityMode(openai, 'openai_chat')).toBe('native')
  })

  it('updates inherited protocol model bindings when the top-level mapping changes', () => {
    expect(resolveChannelModelBindingUpstreamModel({
      currentModel: 'glm-5.3', nextModel: 'glm-5.4', currentBinding: 'glm-5.3', override: 'glm-5.3'
    })).toBe('glm-5.4')
    expect(resolveChannelModelBindingUpstreamModel({
      currentModel: 'glm-5.3', nextModel: 'glm-5.4', currentBinding: 'glm-5.3', override: 'glm-5.3-chat'
    })).toBe('glm-5.3-chat')
    expect(resolveChannelModelBindingUpstreamModel({
      currentModel: 'glm-5.3', nextModel: 'glm-5.3', currentBinding: 'glm-5.2', override: 'glm-5.2'
    })).toBe('glm-5.2')
  })

  it('uses the OpenAI protocol for the shared model catalog before a Messages override', () => {
    const messages = { protocol: 'anthropic_messages' as const, baseUrlOverride: 'https://api.deepseek.com/anthropic' }
    const chat = { protocol: 'openai_chat' as const, baseUrlOverride: null }
    expect(preferredModelDiscoveryProtocol([messages, chat])).toBe(chat)
  })

  it('does not select a disabled protocol for discovery', () => {
    const disabledResponses = { protocol: 'openai_responses' as const, enabled: false }
    const enabledChat = { protocol: 'openai_chat' as const, enabled: true }
    expect(preferredModelDiscoveryProtocol([disabledResponses, enabledChat])).toBe(enabledChat)
  })

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
    expect(mergeUserFailoverSourceIds(['relay:b', 'package', 'relay:removed'], ['a', 'b'])).toEqual(['relay_group:b', 'package', 'relay_group:a'])
  })

  it('adds a provisioned private pool as a draggable failover source', () => {
    expect(mergeUserFailoverSourceIds(['relay:b', 'package'], ['a', 'b'], true, true)).toEqual(['relay_group:b', 'package', 'relay_group:a', 'private_pool'])
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

  it('sorts relay accounts by balance and always puts depleted accounts last', () => {
    const account = (id: string, balance: number | null, routingState: 'active' | 'depleted', accountRank: number) => ({
      id, accountRank, createdAt: accountRank, state: { remainingBalance: balance, routingState }
    }) as never
    const accounts = [account('a', 20, 'active', 20), account('b', 80, 'active', 10), account('c', 100, 'depleted', 5)]
    expect(sortRelayAccounts(accounts, 'balance_desc').map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect(sortRelayAccounts(accounts, 'balance_asc').map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(sortRelayAccounts(accounts, 'manual').map(item => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('distinguishes exhausted quota from temporary rate limits', () => {
    expect(classifyRelayFailure(429, JSON.stringify({ error: { code: 'insufficient_quota' } }))).toBe('quota_exhausted')
    expect(classifyRelayFailure(429, JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))).toBe('rate_limited')
    expect(classifyRelayFailure(401, 'invalid api key')).toBe('credential_error')
    expect(classifyRelayFailure(404, 'model does not exist')).toBe('model_missing')
  })

  it('fails over private relay accounts by classified upstream error', () => {
    expect(relayFailureAllowsFailover(400, 'quota_exhausted', true)).toBe(true)
    expect(relayFailureAllowsFailover(402, 'quota_exhausted', true)).toBe(true)
    expect(relayFailureAllowsFailover(400, 'client_error', true)).toBe(false)
    expect(relayFailureAllowsFailover(404, 'model_missing', true)).toBe(true)
    expect(relayFailureAllowsFailover(404, 'model_missing', false)).toBe(false)
  })

  it('does not open an account-wide circuit for model-specific failures', () => {
    expect(relayFailureAffectsAccount('quota_exhausted')).toBe(true)
    expect(relayFailureAffectsAccount('rate_limited')).toBe(true)
    expect(relayFailureAffectsAccount('model_missing')).toBe(false)
    expect(relayFailureAffectsAccount('model_denied')).toBe(false)
  })
})
