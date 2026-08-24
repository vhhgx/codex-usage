import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { createError } from 'h3'

vi.stubGlobal('createError', createError)

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  inserted: [] as Array<Record<string, unknown>>
}))
const adminFetch = vi.hoisted(() => vi.fn())
const userFetch = vi.hoisted(() => vi.fn())
const getUserPlan = vi.hoisted(() => vi.fn())
const redis = vi.hoisted(() => ({ set: vi.fn(), eval: vi.fn() }))

vi.mock('../server/db', () => ({
  useDatabase: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.selectResults.shift() || [],
          orderBy: async () => state.selectResults.shift() || []
        })
      })
    }),
    insert: () => ({ values: (value: Record<string, unknown>) => { state.inserted.push(value); return { returning: async () => [] } } })
  })
}))
vi.mock('../server/services/sub2api-admin', () => ({ sub2ApiAdminFetch: adminFetch, sub2ApiUserFetch: userFetch }))
vi.mock('../server/services/customer-management', () => ({ getUserPlan }))
vi.mock('../server/utils/redis', () => ({ useRedis: () => redis }))
vi.mock('../server/utils/hub-crypto', () => ({
  encryptContextSecret: () => 'encrypted-key',
  decryptContextSecret: () => 'decrypted-key'
}))

import { importUserPoolAccount, provisionUserPool } from '../server/services/user-pool'

const event = {} as H3Event
const owner = { id: 'user-1', role: 'user' }

afterEach(() => {
  vi.clearAllMocks()
  state.selectResults = []
  state.inserted = []
})

describe('user pool provisioning', () => {
  it('uses the current Sub2API admin and user endpoint contracts', async () => {
    const now = new Date()
    const storedPool = {
      id: 'pool-1', ownerUserId: owner.id, displayName: '我的专属号池', internalName: 'zh_pool_test',
      status: 'active', maxAccounts: 3, lastReconciledAt: null, lastError: null, createdAt: now, updatedAt: now
    }
    state.selectResults = [[owner], [], [], [owner], [storedPool], []]
    getUserPlan.mockResolvedValue({
      status: 'active',
      plan: { entitlementSnapshot: { supplyMode: 'private_only', maxPoolAccounts: 3 }, version: null }
    })
    redis.set.mockResolvedValue('OK')
    redis.eval.mockResolvedValue(1)
    adminFetch.mockImplementation(async (_event, path) => {
      if (path === '/groups') return { id: 21 }
      if (path === '/users') return { id: 31 }
      if (path === '/subscriptions/assign') return { id: 41 }
      throw new Error(`unexpected admin path ${path}`)
    })
    userFetch.mockImplementation(async (_event, path) => {
      if (path === '/auth/login') return { access_token: 'user-access-token' }
      if (path === '/keys') return { id: 51, key: 'upstream-api-key' }
      throw new Error(`unexpected user path ${path}`)
    })

    await provisionUserPool(event, owner.id)

    expect(adminFetch.mock.calls.map(call => call[1])).toEqual(['/groups', '/users', '/subscriptions/assign'])
    expect(userFetch.mock.calls.map(call => call[1])).toEqual(['/auth/login', '/keys'])
    expect(adminFetch.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ role: 'user', allowed_groups: [21], email: expect.stringMatching(/@hub\.invalid$/) })
    }))
    expect(adminFetch.mock.calls[2]?.[2]).toEqual(expect.objectContaining({
      method: 'POST', body: expect.objectContaining({ user_id: 31, group_id: 21 })
    }))
    expect(userFetch.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      method: 'POST', body: { group_id: 21, name: expect.any(String) }
    }))
    expect(state.inserted[0]).toEqual(expect.objectContaining({
      ownerUserId: owner.id, upstreamUserId: 31, upstreamGroupId: 21, upstreamApiKeyId: 51,
      encryptedUpstreamApiKey: 'encrypted-key', maxAccounts: 3
    }))
  })

  it('allows an active platform-only full package to create a private pool', async () => {
    const now = new Date()
    const storedPool = {
      id: 'pool-2', ownerUserId: owner.id, displayName: '我的专属号池', internalName: 'zh_pool_full',
      status: 'active', maxAccounts: null, lastReconciledAt: null, lastError: null, createdAt: now, updatedAt: now
    }
    state.selectResults = [[owner], [], [], [owner], [storedPool], []]
    getUserPlan.mockResolvedValue({ status: 'active', plan: { entitlementSnapshot: { supplyMode: 'platform_only' } } })
    redis.set.mockResolvedValue('OK')
    redis.eval.mockResolvedValue(1)
    adminFetch.mockImplementation(async (_event, path) => {
      if (path === '/groups') return { id: 22 }
      if (path === '/users') return { id: 32 }
      if (path === '/subscriptions/assign') return { id: 42 }
      throw new Error(`unexpected admin path ${path}`)
    })
    userFetch.mockImplementation(async (_event, path) => {
      if (path === '/auth/login') return { access_token: 'full-user-access-token' }
      if (path === '/keys') return { id: 52, key: 'full-upstream-api-key' }
      throw new Error(`unexpected user path ${path}`)
    })

    await expect(provisionUserPool(event, owner.id)).resolves.toMatchObject({ pool: { id: 'pool-2' } })
    expect(adminFetch).toHaveBeenCalledTimes(3)
    expect(userFetch).toHaveBeenCalledTimes(2)
  })

  it('normalizes imported credentials and always binds the private pool group', async () => {
    const now = new Date()
    const pool = {
      id: 'pool-import', ownerUserId: owner.id, displayName: '我的专属号池', internalName: 'zh_pool_import',
      status: 'active', maxAccounts: null, upstreamGroupId: 77, lastReconciledAt: null, lastError: null,
      createdAt: now, updatedAt: now
    }
    state.selectResults = [[pool]]
    getUserPlan.mockResolvedValue({ status: 'active', plan: { entitlementSnapshot: { supplyMode: 'private_only' } } })
    adminFetch.mockImplementation(async (_event, path) => {
      if (path === '/accounts') return { id: 88, platform: 'openai', type: 'apikey', status: 'active', email: 'imported@example.com' }
      if (path === '/accounts/88') return { id: 88, group_ids: [77], platform: 'openai', type: 'apikey', status: 'active', email: 'imported@example.com' }
      if (path === '/accounts/88/schedulable') return { ok: true }
      throw new Error(`unexpected admin path ${path}`)
    })

    await importUserPoolAccount(event, owner.id, {
      key: 'ui-only-field', displayName: 'Imported account', platform: 'openai', type: 'apikey',
      credentials: { api_key: 'secret-key' }, extra: { source: 'fixture' }, concurrency: 12,
      priority: 4, rateMultiplier: 2.5, groupIds: ['attacker-group'], proxyId: 'attacker-proxy'
    }, owner.id)

    expect(adminFetch.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        name: 'Imported account', platform: 'openai', type: 'apikey', concurrency: 12,
        priority: 4, rate_multiplier: 2.5, group_ids: [77], proxy_id: null
      })
    }))
    expect(adminFetch.mock.calls[0]?.[2]?.body).not.toHaveProperty('groupIds')
    expect(adminFetch.mock.calls[0]?.[2]?.body).not.toHaveProperty('key')
  })
})
