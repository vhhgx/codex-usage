import { describe, expect, it } from 'vitest'
import type { ServicePlan, UserSubscription } from '../server/db/schema'
import { subscriptionAdmissionScope } from '../server/services/hub-limits'

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
