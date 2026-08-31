import { describe, expect, it } from 'vitest'
import type { ServicePlan, UserSubscription } from '../server/db/schema'
import { subscriptionAdmissionScope } from '../server/services/hub-limits'
import { effectivePlatformExpiry, isPlatformAccessExpired, planValues } from '../server/services/customer-management'

function subscription(overrides: Partial<UserSubscription> = {}): UserSubscription {
  const startsAt = new Date('2026-08-01T00:00:00.000Z')
  return {
    id: 'subscription-id',
    userId: 'user-id',
    planId: 'plan-id',
    startsAt,
    expiresAt: new Date('2026-08-08T00:00:00.000Z'),
    status: 'active',
    assignedBy: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    ...overrides
  }
}

function plan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  const createdAt = new Date('2026-08-01T00:00:00.000Z')
  return {
    id: 'plan-id',
    name: 'Token 周卡',
    description: null,
    mode: 'token',
    cycle: 'week',
    tokenLimit: 1_000_000,
    costLimit: null,
    price: '10',
    status: 'active',
    createdBy: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

describe('customer plan admission scope', () => {
  it('enforces a Token quota from the subscription start', () => {
    const scope = subscriptionAdmissionScope(subscription(), plan())
    expect(scope).toMatchObject({
      kind: 'subscription',
      usageOwnerId: 'user-id',
      periods: [{ suffix: 'cycle', tokenLimit: 1_000_000, costLimit: null }]
    })
    expect(scope?.periods[0]?.startsAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('enforces a monetary quota and skips counters for unlimited plans', () => {
    expect(subscriptionAdmissionScope(subscription(), plan({ mode: 'cost', tokenLimit: null, costLimit: '25.5' })))
      .toMatchObject({ periods: [{ tokenLimit: null, costLimit: '25.5' }] })
    expect(subscriptionAdmissionScope(subscription(), plan({ mode: 'unlimited', tokenLimit: null }))).toBeNull()
  })
})

describe('customer plan input', () => {
  it('lets the new billing mode override a stale legacy mode', () => {
    expect(planValues({ name: '600M 套餐', mode: 'unlimited', billingMode: 'token_package', tokenLimit: 600_000_000 })).toMatchObject({
      mode: 'token',
      tokenLimit: 600_000_000,
      costLimit: null
    })
  })

  it('rejects a Token package without a positive whole-token quota', () => {
    expect(() => planValues({ name: '无额度套餐', billingMode: 'token_package', tokenLimit: null })).toThrowError(/正整数额度/)
  })
})

describe('user platform access expiry', () => {
  it('uses the earlier of the package cycle and account platform expiry', () => {
    expect(effectivePlatformExpiry(new Date('2026-09-01T00:00:00Z'), new Date('2026-08-20T00:00:00Z'))?.toISOString()).toBe('2026-08-20T00:00:00.000Z')
    expect(effectivePlatformExpiry(null, null)).toBeNull()
  })

  it('expires platform access without changing personal-resource state', () => {
    expect(isPlatformAccessExpired(null, new Date('2026-08-25T00:00:00Z'), new Date('2026-08-26T00:00:00Z'))).toBe(true)
    expect(isPlatformAccessExpired(null, new Date('2026-08-27T00:00:00Z'), new Date('2026-08-26T00:00:00Z'))).toBe(false)
  })
})
