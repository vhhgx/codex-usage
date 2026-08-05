import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { deleteManagedCpaAuthFile, setManagedCpaAuthFileDisabled, setManagedCpaDefaultProxy, uploadManagedCpaAuthFile } from '../server/services/cpa'
import { createManagedSub2ApiAccount, createManagedSub2ApiOpenAiOAuthAccount, createManagedSub2ApiProxy, deleteManagedSub2ApiGroup, importManagedSub2ApiData, listManagedSub2ApiProxies, resolveSub2ApiProxySelection, updateManagedSub2ApiGroup, updateManagedSub2ApiProxy, verifyManagedSub2ApiAccount } from '../server/services/sub2api-admin'
import { accountImportPayload } from '../server/services/upstream-input'
import { opaqueAccountId, opaqueSub2ApiAccountId, opaqueSub2ApiGroupId, opaqueSub2ApiProxyId } from '../server/utils/security'

const event = {} as H3Event
const config = {
  cpaBaseUrl: 'http://cpa.test', cpaManagementKey: 'management-secret',
  sub2apiBaseUrl: 'http://sub.test', sub2apiAdminApiKey: 'admin-secret',
  accountIdSecret: 'a'.repeat(32)
}

describe('official upstream write contracts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uploads CPA auth JSON with the official path, query and content type, then reconciles', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ files: [{ name: 'codex.json', auth_index: 'auth-1', type: 'codex', status: 'active' }] })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const bytes = Buffer.from('{"type":"codex"}')
    const result = await uploadManagedCpaAuthFile(event, 'codex.json', bytes)
    expect(result.name).toBe('codex.json')
    expect(fetch).toHaveBeenNthCalledWith(1, 'http://cpa.test/v0/management/auth-files', expect.objectContaining({
      method: 'POST', query: { name: 'codex.json' }, body: bytes,
      headers: expect.objectContaining({ Authorization: 'Bearer management-secret', 'content-type': 'application/json' })
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://cpa.test/v0/management/auth-files', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer management-secret' })
    }))
  })

  it('creates a Sub2API account safely, assigns groups, enables scheduling, and reads it back', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { id: 42 } })
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: { id: 42, name: 'Imported', platform: 'openai', type: 'oauth', status: 'active', schedulable: true, concurrency: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const payload = { name: 'Imported', platform: 'openai', type: 'oauth', credentials: { token: 'not-persisted' }, group_ids: [9] }
    const result = await createManagedSub2ApiAccount(event, payload)
    expect(result.schedulable).toBe(true)
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'http://sub.test/api/v1/admin/accounts',
      'http://sub.test/api/v1/admin/accounts/42/schedulable',
      'http://sub.test/api/v1/admin/accounts/42',
      'http://sub.test/api/v1/admin/accounts/42/schedulable',
      'http://sub.test/api/v1/admin/accounts/42'
    ])
    expect(fetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: { schedulable: false } }))
    expect(fetch.mock.calls[0]?.[1].body).toEqual(expect.objectContaining({ group_ids: [] }))
    expect(fetch.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'PUT', body: { group_ids: [9] } }))
    expect(fetch.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: { schedulable: true } }))
  })

  it('submits an OpenAI OAuth session to Sub2API, then disables and reconciles the account', async () => {
    const created = {
      id: 43, name: 'oauth@example.com', platform: 'openai', type: 'oauth',
      status: 'active', schedulable: true, concurrency: 10, priority: 2, group_ids: [9]
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: created })
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: { ...created, schedulable: false } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)

    const result = await createManagedSub2ApiOpenAiOAuthAccount(event, {
      sessionId: 'session-id',
      code: 'one-time-code',
      state: 'oauth-state',
      name: '',
      concurrency: 10,
      priority: 2,
      groupIds: [9],
      proxyId: 5,
      schedulable: false
    })

    expect(result).toMatchObject({ name: 'oauth@example.com', schedulable: false })
    expect(fetch).toHaveBeenNthCalledWith(1, 'http://sub.test/api/v1/admin/openai/create-from-oauth', expect.objectContaining({
      method: 'POST',
      body: {
        session_id: 'session-id', code: 'one-time-code', state: 'oauth-state', name: '',
        concurrency: 10, priority: 2, group_ids: [9], proxy_id: 5
      }
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://sub.test/api/v1/admin/accounts/43/schedulable', expect.objectContaining({
      method: 'POST', body: { schedulable: false }
    }))
    expect(fetch).toHaveBeenNthCalledWith(3, 'http://sub.test/api/v1/admin/accounts/43', expect.any(Object))
  })

  it('lists Sub2API proxies through opaque IDs without returning passwords', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [{
      id: 5, name: 'HK exit', protocol: 'socks5h', host: 'proxy.test', port: 1080,
      username: 'hub', password: 'must-not-leak', status: 'active', account_count: 2,
      fallback_mode: 'direct', expiry_warn_days: 7
    }], pages: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const [proxy] = await listManagedSub2ApiProxies(event)
    expect(proxy?.view.id).toBe(opaqueSub2ApiProxyId(event, 5))
    expect(proxy?.view.hasPassword).toBe(true)
    expect(proxy?.view.accountCount).toBe(2)
    expect(JSON.stringify(proxy?.view)).not.toContain('must-not-leak')
    expect(proxy?.view).not.toHaveProperty('password')
  })

  it('sets the CPA global proxy from the shared pool without exposing its password', async () => {
    const proxyEvent = {
      context: {
        hubDatabaseTransaction: {
          update: () => ({
            set: (values: Record<string, unknown>) => ({
              where: () => ({ returning: async () => [{ ...values }] })
            })
          })
        }
      }
    } as unknown as H3Event
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { items: [{
        id: 5, name: 'Shared exit', protocol: 'http', host: 'proxy.test', port: 8080,
        username: 'hub', password: 'p@ssword', status: 'active', account_count: 0
      }], pages: 1 } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ 'proxy-url': 'http://hub:p%40ssword@proxy.test:8080' })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)

    const result = await setManagedCpaDefaultProxy(proxyEvent, opaqueSub2ApiProxyId(proxyEvent, 5))

    expect(result.cpaDefaultProxyId).toBe(opaqueSub2ApiProxyId(proxyEvent, 5))
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://cpa.test/v0/management/proxy-url', expect.objectContaining({
      method: 'PATCH', body: { value: 'http://hub:p%40ssword@proxy.test:8080' }
    }))
    expect(JSON.stringify(result)).not.toContain('p%40ssword')
  })

  it('creates and fully updates a Sub2API proxy while keeping the password write-only', async () => {
    const row = { id: 5, name: 'HK exit', protocol: 'http', host: 'proxy.test', port: 8080, username: 'hub', password: 'upstream-secret', status: 'active', account_count: 0, fallback_mode: 'direct', backup_proxy_id: null, expiry_warn_days: 7 }
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { id: 5 } })
      .mockResolvedValueOnce({ code: 0, data: { items: [row], pages: 1 } })
      .mockResolvedValueOnce({ code: 0, data: { items: [row], pages: 1 } })
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: { items: [{ ...row, name: 'HK primary' }], pages: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    expect((await createManagedSub2ApiProxy(event, { name: row.name, protocol: row.protocol, host: row.host, port: row.port })).name).toBe(row.name)
    const updated = await updateManagedSub2ApiProxy(event, opaqueSub2ApiProxyId(event, 5), { name: 'HK primary' })
    expect(updated.name).toBe('HK primary')
    expect(fetch).toHaveBeenNthCalledWith(4, 'http://sub.test/api/v1/admin/proxies/5', expect.objectContaining({
      method: 'PUT',
      body: expect.objectContaining({ name: 'HK primary', protocol: 'http', host: 'proxy.test', port: 8080, fallback_mode: 'direct' })
    }))
    expect(fetch.mock.calls[3]?.[1].body).not.toHaveProperty('password')
  })

  it('resolves an omitted account proxy to the active Hub default', async () => {
    const settings = {
      id: 1, timezone: 'Asia/Shanghai', bodyRetentionDays: 30, metadataRetentionDays: 365,
      defaultTimeoutMs: 120000, circuitFailureThreshold: 3, circuitCooldownMs: 30000,
      sub2apiDefaultProxyUpstreamId: 5, createdAt: new Date(), updatedAt: new Date()
    }
    const database = {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [settings] }) }) })
    }
    const proxyEvent = { context: { hubDatabaseTransaction: database } } as unknown as H3Event
    const fetch = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [{
      id: 5, name: 'Default', protocol: 'http', host: 'proxy.test', port: 8080,
      status: 'active', account_count: 0
    }], pages: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    expect(await resolveSub2ApiProxySelection(proxyEvent, undefined, true)).toBe(5)
  })

  it('represents a direct Sub2API connection with a null proxy foreign key', async () => {
    expect(await resolveSub2ApiProxySelection(event, null, false)).toBeNull()
    expect(await resolveSub2ApiProxySelection(event, undefined, false)).toBeNull()
  })

  it('keeps an explicit direct connection null in the complete account import payload', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [], pages: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const payload = await accountImportPayload(event, {
      name: 'Direct account', platform: 'openai', type: 'oauth', proxyId: null, groupIds: []
    }, { refresh_token: 'synthetic-refresh' })
    expect(payload.proxy_id).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails active verification and removes a deactivated workspace account from scheduling', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { items: [{ id: 42, name: 'Deactivated team member', platform: 'openai', type: 'oauth', status: 'active', schedulable: true, concurrency: 1 }], page: 1, pages: 1 } })
      .mockResolvedValueOnce({ code: 0, data: { updated_at: '2026-07-31T09:00:00Z', five_hour: { utilization: 0 }, seven_day: { utilization: 0 } } })
      .mockResolvedValueOnce({ code: 0, data: { id: 42, status: 'error', schedulable: false, error_message: 'Workspace deactivated (402): workspace has been deactivated' } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))

    await expect(verifyManagedSub2ApiAccount(event, opaqueSub2ApiAccountId(event, 42), true))
      .rejects.toThrow(/deactivated_workspace.*已自动移出调度池/)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenNthCalledWith(3, 'http://sub.test/api/v1/admin/accounts/42', expect.any(Object))
  })

  it('imports an official Sub2API data bundle with default-group binding enabled', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ code: 0, data: { account_created: 3, account_failed: 0, proxy_created: 0, proxy_reused: 0, proxy_failed: 0 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const data = { type: 'sub2api-data', version: 1, accounts: [], proxies: [] }
    expect((await importManagedSub2ApiData(event, data, true)).accountCreated).toBe(3)
    expect(fetch).toHaveBeenCalledWith('http://sub.test/api/v1/admin/accounts/data', expect.objectContaining({
      method: 'POST', body: { data, skip_default_group_bind: false }
    }))
  })

  it('uses the official CPA status and delete contracts and reconciles each write', async () => {
    const auth = { name: 'codex.json', auth_index: 'auth-1', type: 'codex', status: 'active', disabled: false }
    const fetch = vi.fn()
      .mockResolvedValueOnce({ files: [auth] })
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ files: [{ ...auth, status: 'disabled', disabled: true }] })
      .mockResolvedValueOnce({ files: [{ ...auth, status: 'disabled', disabled: true }] })
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ files: [] })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const id = opaqueAccountId(event, 'auth-1')
    expect((await setManagedCpaAuthFileDisabled(event, id, true)).disabled).toBe(true)
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://cpa.test/v0/management/auth-files/status', expect.objectContaining({
      method: 'PATCH', body: { name: 'codex.json', auth_index: 'auth-1', disabled: true }
    }))
    expect(await deleteManagedCpaAuthFile(event, id)).toEqual({ deleted: true, name: 'codex.json' })
    expect(fetch).toHaveBeenNthCalledWith(5, 'http://cpa.test/v0/management/auth-files', expect.objectContaining({
      method: 'DELETE', query: { name: 'codex.json' }
    }))
  })

  it('updates a Sub2API group through PUT and reconciles through the group list', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ code: 0, data: { items: [{ id: 7, name: 'Primary', platform: 'openai', status: 'active', account_count: 0 }], pages: 1 } })
      .mockResolvedValueOnce({ code: 0, data: {} })
      .mockResolvedValueOnce({ code: 0, data: { items: [{ id: 7, name: 'Primary', platform: 'openai', status: 'active', rate_multiplier: 1.2, account_count: 0 }], pages: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    const result = await updateManagedSub2ApiGroup(event, opaqueSub2ApiGroupId(event, 7), { rate_multiplier: 1.2 })
    expect(result.rateMultiplier).toBe(1.2)
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://sub.test/api/v1/admin/groups/7', expect.objectContaining({
      method: 'PUT', body: { rate_multiplier: 1.2 }
    }))
  })

  it('blocks deleting a referenced Sub2API group before issuing DELETE', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [{ id: 7, name: 'In use', platform: 'openai', status: 'active', account_count: 2 }], pages: 1 } })
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.stubGlobal('createError', (input: { message: string }) => Object.assign(new Error(input.message), input))
    await expect(deleteManagedSub2ApiGroup(event, opaqueSub2ApiGroupId(event, 7))).rejects.toThrow(/仍被 2 个账号/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
