import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'
import { createHash, randomBytes } from 'node:crypto'
import { useDatabase } from '../db'
import { userPoolAccounts, userPoolGroups, users } from '../db/schema'
import { encryptContextSecret } from '../utils/hub-crypto'
import { sub2ApiAdminFetch } from './sub2api-admin'
import { parseSub2ApiOpenAiCallback } from './sub2api-oauth'
import { useRedis } from '../utils/redis'

type RecordValue = Record<string, unknown>
const OAUTH_TTL = 15 * 60
function oauthKey(value: string) { return `hub:user-pool-oauth:${createHash('sha256').update(value).digest('hex')}` }

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, 500) : fallback
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function publicPool(pool: typeof userPoolGroups.$inferSelect, accounts: Array<typeof userPoolAccounts.$inferSelect>) {
  return {
    id: pool.id,
    displayName: pool.displayName,
    internalName: pool.internalName,
    status: pool.status,
    maxAccounts: pool.maxAccounts,
    accountCount: accounts.filter(item => !item.removedAt).length,
    availableAccountCount: accounts.filter(item => !item.removedAt && item.status === 'active' && item.schedulable).length,
    lastReconciledAt: pool.lastReconciledAt?.getTime() || null,
    lastError: pool.lastError,
    createdAt: pool.createdAt.getTime(),
    updatedAt: pool.updatedAt.getTime()
  }
}

function publicAccount(account: typeof userPoolAccounts.$inferSelect) {
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    platform: account.platform,
    accountType: account.accountType,
    status: account.status,
    schedulable: account.schedulable,
    source: account.source,
    lastVerifiedAt: account.lastVerifiedAt?.getTime() || null,
    lastError: account.lastError,
    createdAt: account.createdAt.getTime(),
    updatedAt: account.updatedAt.getTime()
  }
}

export async function getUserPool(event: H3Event, ownerUserId: string) {
  const db = useDatabase(event)
  const [owner] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, ownerUserId)).limit(1)
  if (!owner || owner.role !== 'user') throw createError({ statusCode: 404, message: '用户不存在' })
  const [pool] = await db.select().from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  if (!pool) return { pool: null, accounts: [] }
  const accounts = await db.select().from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, pool.id), isNull(userPoolAccounts.removedAt))).orderBy(asc(userPoolAccounts.createdAt))
  return { pool: publicPool(pool, accounts), accounts: accounts.map(publicAccount) }
}

async function resolveOwnedPool(event: H3Event, ownerUserId: string, poolId?: string) {
  const [pool] = await useDatabase(event).select().from(userPoolGroups).where(and(
    eq(userPoolGroups.ownerUserId, ownerUserId),
    poolId ? eq(userPoolGroups.id, poolId) : undefined
  )).limit(1)
  if (!pool) throw createError({ statusCode: 404, message: '专属号池不存在' })
  return pool
}

export async function updateUserPool(event: H3Event, ownerUserId: string, body: RecordValue) {
  const pool = await resolveOwnedPool(event, ownerUserId)
  const displayName = body.displayName === undefined ? pool.displayName : text(body.displayName)
  if (!displayName) throw createError({ statusCode: 400, message: '号池名称不能为空' })
  await useDatabase(event).update(userPoolGroups).set({ displayName, updatedAt: new Date() }).where(and(eq(userPoolGroups.id, pool.id), eq(userPoolGroups.ownerUserId, ownerUserId)))
  return getUserPool(event, ownerUserId)
}

export async function provisionUserPool(event: H3Event, ownerUserId: string, actorId?: string) {
  const [owner] = await useDatabase(event).select({ id: users.id, role: users.role }).from(users).where(eq(users.id, ownerUserId)).limit(1)
  if (!owner || owner.role !== 'user') throw createError({ statusCode: 404, message: '用户不存在' })
  const existing = await useDatabase(event).select().from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  if (existing[0]) return getUserPool(event, ownerUserId)
  const poolId = randomUUID()
  const internalName = `zh_pool_${poolId.replace(/-/g, '').slice(0, 12)}`
  let upstreamUserId: number
  let upstreamGroupId: number
  let upstreamApiKeyId: number
  let upstreamApiKey = ''
  try {
    const user = record(await sub2ApiAdminFetch(event, '/users', { method: 'POST', body: { username: internalName, display_name: internalName } }))
    upstreamUserId = numberValue(user.id) || numberValue(record(user.data).id) || 0
    const group = record(await sub2ApiAdminFetch(event, '/groups', { method: 'POST', body: {
      name: internalName,
      description: `Managed by Zephyr Hub; pool=${poolId}`,
      subscription_type: 'subscription',
      is_exclusive: true,
      platform: 'openai',
      status: 'active',
      rate_multiplier: 1,
      fallback_group_id: null,
      fallback_group_id_on_invalid_request: null
    } }))
    upstreamGroupId = numberValue(group.id) || numberValue(record(group.data).id) || 0
    const subscription = record(await sub2ApiAdminFetch(event, '/subscriptions', { method: 'POST', body: { user_id: upstreamUserId, group_id: upstreamGroupId, status: 'active' } }))
    const key = record(await sub2ApiAdminFetch(event, '/keys', { method: 'POST', body: { user_id: upstreamUserId, group_id: upstreamGroupId, name: internalName } }))
    upstreamApiKeyId = numberValue(key.id) || numberValue(record(key.data).id) || 0
    upstreamApiKey = text(key.key || key.api_key || key.token || record(key.data).key || record(key.data).api_key)
    void subscription
    if (!upstreamUserId || !upstreamGroupId || !upstreamApiKeyId || !upstreamApiKey) throw new Error('Sub2API 创建专属池资源返回不完整')
  } catch (error) {
    throw createError({ statusCode: 502, message: error instanceof Error ? error.message : '创建专属号池失败', data: { reconciliationRequired: true } })
  }
  await useDatabase(event).insert(userPoolGroups).values({
    id: poolId,
    ownerUserId,
    upstreamUserId,
    upstreamGroupId,
    upstreamApiKeyId,
    encryptedUpstreamApiKey: encryptContextSecret(upstreamApiKey, `user-pool:${poolId}`, event),
    encryptionKeyVersion: 'v2',
    internalName,
    displayName: '我的专属号池',
    status: 'active',
    createdBy: actorId || null
  })
  return getUserPool(event, ownerUserId)
}

export async function startUserPoolOAuth(event: H3Event, ownerUserId: string) {
  const pool = await resolveOwnedPool(event, ownerUserId)
  const result = record(await sub2ApiAdminFetch(event, '/openai/generate-auth-url', { method: 'POST', body: {} }))
  const authorizationUrl = text(result.auth_url)
  const sessionId = text(result.session_id)
  if (!authorizationUrl || !sessionId) throw createError({ statusCode: 502, message: 'Sub2API OAuth 响应不完整' })
  const flowId = randomBytes(32).toString('base64url')
  await useRedis(event).set(oauthKey(flowId), JSON.stringify({ ownerUserId, poolId: pool.id, sessionId, expiresAt: Date.now() + OAUTH_TTL * 1000 }), 'EX', OAUTH_TTL)
  return { authorizationUrl, flowId, expiresAt: Date.now() + OAUTH_TTL * 1000 }
}

export async function completeUserPoolOAuth(event: H3Event, ownerUserId: string, body: RecordValue) {
  const flowId = text(body.flowId)
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(flowId)) throw createError({ statusCode: 400, message: 'OAuth 流程 ID 无效' })
  const callback = parseSub2ApiOpenAiCallback(body.callbackUrl)
  const raw = await useRedis(event).get(oauthKey(flowId))
  let parsedFlow: unknown = null
  try { parsedFlow = raw ? JSON.parse(raw) : null } catch {}
  const flow = record(parsedFlow)
  if (flow.ownerUserId !== ownerUserId || typeof flow.poolId !== 'string' || Number(flow.expiresAt) <= Date.now()) throw createError({ statusCode: 410, message: 'OAuth 授权流程已过期或不属于当前账号' })
  const pool = await resolveOwnedPool(event, ownerUserId, flow.poolId)
  await useRedis(event).del(oauthKey(flowId))
  const created = record(await sub2ApiAdminFetch(event, '/openai/create-from-oauth', { method: 'POST', body: { session_id: flow.sessionId, code: callback.code, state: callback.state, name: text(body.name, '我的 OpenAI 账号'), concurrency: 10, priority: 0, group_ids: [pool.upstreamGroupId], extra: { codex_cli_only: true, codex_fingerprint_mode: 'session' } } }))
  const upstreamAccountId = numberValue(created.id)
  if (!upstreamAccountId) throw createError({ statusCode: 502, message: 'OAuth 账号创建后未返回账号 ID', data: { reconciliationRequired: true } })
  await sub2ApiAdminFetch(event, `/accounts/${upstreamAccountId}`, { method: 'PUT', body: { group_ids: [pool.upstreamGroupId], extra: { codex_cli_only: true, codex_fingerprint_mode: 'session' } } })
  const [account] = await useDatabase(event).insert(userPoolAccounts).values({ ownerUserId, poolGroupId: pool.id, upstreamAccountId, platform: 'openai', accountType: 'oauth', displayName: text(body.name, `账号 ${upstreamAccountId}`), email: text(created.email) || null, status: text(created.status, 'active'), schedulable: false, source: 'oauth' }).returning()
  return account ? publicAccount(account) : null
}

export async function importUserPoolAccount(event: H3Event, ownerUserId: string, body: RecordValue, actorId?: string) {
  const pool = await resolveOwnedPool(event, ownerUserId)
  const db = useDatabase(event)
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, pool.id), isNull(userPoolAccounts.removedAt)))
  if (pool.maxAccounts && countRow && Number(countRow.count) >= pool.maxAccounts) throw createError({ statusCode: 409, message: '专属号池已达到账号上限' })
  const payload = { ...body }
  delete payload.ownerUserId
  delete payload.poolGroupId
  delete payload.upstreamAccountId
  delete payload.upstreamUserId
  delete payload.upstreamGroupId
  delete payload.upstreamApiKeyId
  delete payload.group_ids
  delete payload.groupIds
  payload.group_ids = [pool.upstreamGroupId]
  payload.extra = { ...record(payload.extra), codex_cli_only: true, codex_fingerprint_mode: 'session' }
  const created = record(await sub2ApiAdminFetch(event, '/accounts', { method: 'POST', body: payload }))
  const upstreamAccountId = numberValue(created.id) || numberValue(record(created.data).id)
  if (!upstreamAccountId) throw createError({ statusCode: 502, message: 'Sub2API 创建账号后未返回账号 ID', data: { reconciliationRequired: true } })
  await sub2ApiAdminFetch(event, `/accounts/${upstreamAccountId}`, { method: 'PUT', body: { group_ids: [pool.upstreamGroupId], extra: payload.extra } })
  await sub2ApiAdminFetch(event, `/accounts/${upstreamAccountId}/schedulable`, { method: 'POST', body: { schedulable: false } })
  const confirmed = record(await sub2ApiAdminFetch(event, `/accounts/${upstreamAccountId}`))
  const confirmedGroups = Array.isArray(confirmed.group_ids) ? confirmed.group_ids.map(Number).filter(Number.isFinite) : []
  if (confirmedGroups.length !== 1 || confirmedGroups[0] !== pool.upstreamGroupId) {
    throw createError({ statusCode: 502, message: '账号分组校验失败，已禁止进入调度', data: { reconciliationRequired: true } })
  }
  const [account] = await db.insert(userPoolAccounts).values({
    ownerUserId,
    poolGroupId: pool.id,
    upstreamAccountId,
    platform: text(created.platform, 'openai'),
    accountType: text(created.type, 'oauth'),
    displayName: text(body.displayName || body.name, `账号 ${upstreamAccountId}`),
    email: text(created.email || body.email) || null,
    status: text(created.status, 'active'),
    schedulable: false,
    source: text(body.source, 'import'),
    createdBy: actorId || null
  }).returning()
  return account ? publicAccount(account) : null
}

export async function updateUserPoolAccount(event: H3Event, ownerUserId: string, accountId: string, body: RecordValue) {
  const [account] = await useDatabase(event).select().from(userPoolAccounts).where(and(eq(userPoolAccounts.id, accountId), eq(userPoolAccounts.ownerUserId, ownerUserId), isNull(userPoolAccounts.removedAt))).limit(1)
  if (!account) throw createError({ statusCode: 404, message: '账号不存在' })
  const patch: RecordValue = {}
  if (body.displayName !== undefined) patch.displayName = text(body.displayName) || account.displayName
  if (typeof body.schedulable === 'boolean') {
    await sub2ApiAdminFetch(event, `/accounts/${account.upstreamAccountId}/schedulable`, { method: 'POST', body: { schedulable: body.schedulable } })
    patch.schedulable = body.schedulable
  }
  if (Object.keys(patch).length) await useDatabase(event).update(userPoolAccounts).set({ ...patch, updatedAt: new Date() }).where(eq(userPoolAccounts.id, account.id))
  const [updated] = await useDatabase(event).select().from(userPoolAccounts).where(eq(userPoolAccounts.id, account.id)).limit(1)
  return publicAccount(updated || account)
}

export async function removeUserPoolAccount(event: H3Event, ownerUserId: string, accountId: string) {
  const [account] = await useDatabase(event).select().from(userPoolAccounts).where(and(eq(userPoolAccounts.id, accountId), eq(userPoolAccounts.ownerUserId, ownerUserId), isNull(userPoolAccounts.removedAt))).limit(1)
  if (!account) throw createError({ statusCode: 404, message: '账号不存在' })
  await sub2ApiAdminFetch(event, `/accounts/${account.upstreamAccountId}`, { method: 'DELETE' })
  await useDatabase(event).update(userPoolAccounts).set({ status: 'removed', schedulable: false, removedAt: new Date(), updatedAt: new Date() }).where(and(eq(userPoolAccounts.id, account.id), eq(userPoolAccounts.ownerUserId, ownerUserId)))
  return { deleted: true }
}

export async function verifyUserPoolAccount(event: H3Event, ownerUserId: string, accountId: string) {
  const [account] = await useDatabase(event).select().from(userPoolAccounts).where(and(eq(userPoolAccounts.id, accountId), eq(userPoolAccounts.ownerUserId, ownerUserId), isNull(userPoolAccounts.removedAt))).limit(1)
  if (!account) throw createError({ statusCode: 404, message: '账号不存在' })
  try {
    await sub2ApiAdminFetch(event, `/accounts/${account.upstreamAccountId}/usage`, { query: { source: 'active', force: 'true' } })
    const [updated] = await useDatabase(event).update(userPoolAccounts).set({ lastVerifiedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(userPoolAccounts.id, account.id)).returning()
    return { ok: true, account: updated ? publicAccount(updated) : publicAccount(account) }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : '账号验活失败'
    await useDatabase(event).update(userPoolAccounts).set({ lastVerifiedAt: new Date(), lastError: message, schedulable: false, updatedAt: new Date() }).where(eq(userPoolAccounts.id, account.id))
    throw createError({ statusCode: 422, message: '账号验活失败', data: { detail: message } })
  }
}

export async function reconcileUserPool(event: H3Event, ownerUserId: string) {
  const pool = await resolveOwnedPool(event, ownerUserId)
  const db = useDatabase(event)
  const accounts = await db.select().from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, pool.id), isNull(userPoolAccounts.removedAt)))
  let drifted = 0
  for (const account of accounts) {
    try {
      const raw = record(await sub2ApiAdminFetch(event, `/accounts/${account.upstreamAccountId}`))
      const ids = Array.isArray(raw.group_ids) ? raw.group_ids.map(Number).filter(Number.isFinite) : []
      const exact = ids.length === 1 && ids[0] === pool.upstreamGroupId
      if (!exact) {
        drifted += 1
        await db.update(userPoolAccounts).set({ schedulable: false, status: 'error', lastError: '账号分组已漂移，已停止调度', updatedAt: new Date() }).where(eq(userPoolAccounts.id, account.id))
      }
    } catch (error) {
      drifted += 1
      await db.update(userPoolAccounts).set({ schedulable: false, status: 'error', lastError: (error instanceof Error ? error.message : '对账失败').slice(0, 500), updatedAt: new Date() }).where(eq(userPoolAccounts.id, account.id))
    }
  }
  await db.update(userPoolGroups).set({ lastReconciledAt: new Date(), lastError: drifted ? `${drifted} 个账号分组异常` : null, status: drifted ? 'error' : 'active', updatedAt: new Date() }).where(eq(userPoolGroups.id, pool.id))
  return { ...(await getUserPool(event, ownerUserId)), reconciled: accounts.length, drifted }
}
