import { describe, expect, it } from 'vitest'
import { selectSupplySource } from '../server/services/hub-routing'

describe('user pool supply selection', () => {
  it('keeps elastic requests on platform while quota remains', () => {
    expect(selectSupplySource({ billingMode: 'token_package', supplyMode: 'platform_then_private', estimatedTokens: 100, remainingTokens: 101, privatePoolAvailable: true, subscriptionId: 's', planVersionId: 'v', poolGroupId: 'p' })).toMatchObject({ source: 'platform', reservedTokens: 100 })
  })

  it('switches to the owner pool after quota exhaustion', () => {
    expect(selectSupplySource({ billingMode: 'token_package', supplyMode: 'platform_then_private', estimatedTokens: 100, remainingTokens: 99, privatePoolAvailable: true, poolGroupId: 'p' })).toMatchObject({ source: 'private_pool', poolGroupId: 'p', reservedTokens: 0 })
  })

  it('blocks instead of crossing into another resource domain', () => {
    expect(() => selectSupplySource({ billingMode: 'token_package', supplyMode: 'platform_then_private', estimatedTokens: 100, remainingTokens: 0, privatePoolAvailable: false })).toThrowError(/专属号池当前不可用/)
  })

  it('supports private-only plans without a platform reservation', () => {
    expect(selectSupplySource({ billingMode: 'token_metered', supplyMode: 'private_only', estimatedTokens: 100, remainingTokens: null, privatePoolAvailable: true, poolGroupId: 'p' })).toMatchObject({ source: 'private_pool', reservedTokens: 0 })
  })
})
