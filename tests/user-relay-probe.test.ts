import { describe, expect, it } from 'vitest'
import { interpretRelayCheckinResponse, normalizeUserRelayOrder, selectRelayProbeModel } from '../server/services/user-relays'
import { mergeUserFailoverSourceIds } from '../server/services/user-route-preferences'

describe('private relay protocol probe model selection', () => {
  const models = ['codex-auto-review', 'gpt-image-2', 'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.5-openai-compact']

  it('prefers a general text model for Messages and Chat probes', () => {
    expect(selectRelayProbeModel('anthropic_messages', models)).toBe('gpt-5.6')
    expect(selectRelayProbeModel('openai_chat', models)).toBe('gpt-5.6')
  })

  it('prefers a Codex-capable text model for Responses without selecting utility models', () => {
    expect(selectRelayProbeModel('openai_responses', ['gpt-image-2', 'gpt-5.6', 'gpt-5.6-codex'])).toBe('gpt-5.6-codex')
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
})
