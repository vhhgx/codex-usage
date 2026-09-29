import { describe, expect, it } from 'vitest'
import { compareUserRelayOrder, type UserRelayOrderKey } from '../server/services/hub-routing'

function key(overrides: Partial<UserRelayOrderKey> = {}): UserRelayOrderKey {
  return {
    accountRank: 10,
    protocolScore: 1000,
    scopeOrder: 0,
    balance: null,
    normalizedPrice: null,
    priority: 10,
    name: 'a',
    ...overrides
  }
}

describe('compareUserRelayOrder', () => {
  it('手工顺序最优先，即使另一账号协议匹配更好', () => {
    const first = key({ name: 'first', accountRank: 10, protocolScore: 100 })
    const second = key({ name: 'second', accountRank: 20, protocolScore: 1000 })
    expect(compareUserRelayOrder(first, second, 'manual')).toBeLessThan(0)
    expect(compareUserRelayOrder(second, first, 'manual')).toBeGreaterThan(0)
  })

  it('手工顺序相同时，协议原生匹配（高分）优先', () => {
    const native = key({ name: 'native', accountRank: 10, protocolScore: 1000 })
    const converted = key({ name: 'converted', accountRank: 10, protocolScore: 90 })
    expect(compareUserRelayOrder(native, converted, 'manual')).toBeLessThan(0)
  })

  it('手工顺序与协议都相同时，声明支持该模型品类的渠道优先', () => {
    const declared = key({ name: 'declared', accountRank: 10, protocolScore: 1000, scopeOrder: 0 })
    const undeclared = key({ name: 'undeclared', accountRank: 10, protocolScore: 1000, scopeOrder: 1 })
    expect(compareUserRelayOrder(declared, undeclared, 'manual')).toBeLessThan(0)
  })

  it('余额报错（null）时不参与排序，退回后续规则', () => {
    const known = key({ name: 'known', accountRank: 10, balance: 5, priority: 10 })
    const unknown = key({ name: 'unknown', accountRank: 10, balance: null, priority: 99 })
    // 余额缺失不应当把该账号排到前面或后面，只能由 priority/name 决定
    expect(compareUserRelayOrder(unknown, known, 'manual')).toBeGreaterThan(0)
  })

  it('余额排序模式下余额优先，手工顺序退为次级', () => {
    const rich = key({ name: 'rich', accountRank: 30, balance: 500 })
    const poor = key({ name: 'poor', accountRank: 10, balance: 1 })
    expect(compareUserRelayOrder(rich, poor, 'balance_desc')).toBeLessThan(0)
    expect(compareUserRelayOrder(poor, rich, 'balance_asc')).toBeLessThan(0)
  })

  it('余额排序模式下余额不可信时回退到手工顺序', () => {
    const first = key({ name: 'first', accountRank: 10, balance: null })
    const second = key({ name: 'second', accountRank: 20, balance: 999 })
    expect(compareUserRelayOrder(first, second, 'balance_desc')).toBeLessThan(0)
  })
})
