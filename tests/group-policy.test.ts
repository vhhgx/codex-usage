import { describe, expect, it } from 'vitest'
import { applyGroupChannelPolicy, effectivePriceMultiplier, intersectPolicyValues, policyAllows } from '../server/services/group-policy'

describe('group policy intersection', () => {
  it('treats an empty rule set as inheritance and never widens an explicit parent rule', () => {
    expect(policyAllows([], '/v1/responses')).toBe(true)
    expect(policyAllows(['/v1/embeddings'], '/v1/responses')).toBe(false)
    expect(intersectPolicyValues(['a', 'b', 'c'], ['a', 'b'], ['b', 'c'])).toEqual(['b'])
  })

  it('restricts channels when rules exist and applies priority and weight overrides', () => {
    const rows = [
      { channel: { id: 'a', name: 'A', priority: 10, weight: 1 }, model: 'x' },
      { channel: { id: 'b', name: 'B', priority: 20, weight: 2 }, model: 'x' },
      { channel: { id: 'c', name: 'C', priority: 30, weight: 3 }, model: 'x' }
    ]
    expect(applyGroupChannelPolicy(rows, [
      { channelId: 'a', enabled: true, priorityOverride: 50, weightOverride: 9 },
      { channelId: 'b', enabled: true, priorityOverride: 5, weightOverride: null },
      { channelId: 'c', enabled: false, priorityOverride: null, weightOverride: null }
    ]).map(row => [row.channel.id, row.channel.priority, row.channel.weight])).toEqual([
      ['b', 5, 2], ['a', 50, 9]
    ])
  })

  it('multiplies group, key and channel pricing without allowing negative values', () => {
    expect(effectivePriceMultiplier(1.2, 0.5, 2)).toBe(1.2)
    expect(effectivePriceMultiplier(-1, 2, 3)).toBe(0)
  })
})
