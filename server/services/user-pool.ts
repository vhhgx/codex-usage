import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'
import { createHash, randomBytes } from 'node:crypto'
import { useDatabase } from '../db'
import { smsReceiverBindings, userPoolAccounts, userPoolGroups, users } from '../db/schema'
import { encryptContextSecret } from '../utils/hub-crypto'
import { parseCredentialJson, validateSubCredentialAdapter } from '../utils/safe-json'
import { redactSensitiveText } from '../utils/upstream'
import { sub2ApiAdminFetch, sub2ApiUserFetch } from './sub2api-admin'
import { parseSub2ApiOpenAiCallback } from './sub2api-oauth'
import { useRedis } from '../utils/redis'
import { getUserPlan } from './customer-management'
import { canOwnPersonalResources } from './admin-auth'
import { getAllSub2ApiAccountQuotas } from './sub2api-admin'

type RecordValue = Record<string, unknown>
const OAUTH_TTL = 15 * 60
function oauthKey(value: string) { return `hub:user-pool-oauth:${createHash('sha256').update(value).digest('hex')}` }
function provisionKey(value: string) { return `hub:user-pool-provision:${value}` }

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

async function requirePoolEntitlement(event: H3Event, ownerUserId: string) {
  const subscription = await getUserPlan(event, ownerUserId)
  const plan = record(subscription?.plan)
  const entitlement = record(plan.entitlementSnapshot)
  const version = record(plan.version)
  if (!subscription) throw createError({ statusCode: 403, message: '当前账号没有可用的专属号池配置' })
  return { maxAccounts: numberValue(entitlement.maxPoolAccounts ?? version.maxPoolAccounts) }
}

async function assertPoolCapacity(event: H3Event, pool: typeof userPoolGroups.$inferSelect, maxAccounts = pool.maxAccounts) {
  if (!maxAccounts) return
  const [countRow] = await useDatabase(event).select({ count: sql<number>`count(*)` }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, pool.id), isNull(userPoolAccounts.removedAt)))
  if (countRow && Number(countRow.count) >= maxAccounts) throw createError({ statusCode: 409, message: '专属号池已达到账号上限' })
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
  if (!owner || !canOwnPersonalResources(owner.role)) throw createError({ statusCode: 404, message: '用户不存在' })
  const [pool] = await db.select().from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  if (!pool) return { pool: null, accounts: [] }
  const accounts = await db.select().from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, pool.id), isNull(userPoolAccounts.removedAt))).orderBy(asc(userPoolAccounts.createdAt))
  return { pool: publicPool(pool, accounts), accounts: accounts.map(publicAccount) }
}

export async function getUserPoolUsage(event: H3Event, ownerUserId: string) {
  const pool = await resolveOwnedPool(event, ownerUserId).catch(() => null)
  if (!pool) return { items: [], generatedAt: Date.now() }
  const accounts = await useDatabase(event).select({ id: userPoolAccounts.id, upstreamAccountId: userPoolAccounts.upstreamAccountId }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, pool.id), isNull(userPoolAccounts.removedAt)))
  if (!accounts.length) return { items: [], generatedAt: Date.now() }
  const quotas = await getAllSub2ApiAccountQuotas(event)
  const allowed = new Map(accounts.map(account => [account.upstreamAccountId, account.id]))
  return {
    items: quotas.map(item => {
      const upstreamId = item.upstreamId
      if (upstreamId === undefined) return null
      const accountId = allowed.get(upstreamId)
      return accountId ? { accountId, ...item } : null
    }).filter((item): item is NonNullable<typeof item> => Boolean(item)),
    generatedAt: Date.now()
  }
}

async function resolveOwnedPool(event: H3Event, ownerUserId: string, poolId?: string) {
  const [pool] = await useDatabase(event).select().from(userPoolGroups).where(and(
    eq(userPoolGroups.ownerUserId, ownerUserId),
    poolId ? eq(userPoolGroups.id, poolId) : undefined
  )).limit(1)
  if (!pool) throw createError({ statusCode: 404, message: '专属号池不存在' })
  return pool
}

export async function assertUserPoolAccess(event: H3Event, ownerUserId: string) {
  const pool = await resolveOwnedPool(event, ownerUserId)
  if (pool.status !== 'active') throw createError({ statusCode: 409, message: '专属号池当前不可用' })
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
  if (!owner || !canOwnPersonalResources(owner.role)) throw createError({ statusCode: 404, message: '用户不存在' })
  const existing = await useDatabase(event).select().from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
  if (existing[0]) return getUserPool(event, ownerUserId)
  const { maxAccounts } = await requirePoolEntitlement(event, ownerUserId)
  const redis = useRedis(event)
  const lockToken = randomUUID()
  const lock = provisionKey(ownerUserId)
  if (!await redis.set(lock, lockToken, 'EX', 180, 'NX')) {
    throw createError({ statusCode: 409, message: '专属号池正在创建，请稍后刷新' })
  }
  const poolId = randomUUID()
  const internalName = `zh_pool_${poolId.replace(/-/g, '').slice(0, 12)}`
  const upstreamEmail = `${internalName}@hub.invalid`
  const upstreamPassword = randomBytes(32).toString('base64url')
  let upstreamUserId = 0
  let upstreamGroupId = 0
  let upstreamApiKeyId = 0
  let upstreamApiKey = ''
  let userAccessToken = ''
  let stage = '检查创建状态'
  let stored = false
  try {
    const concurrent = await useDatabase(event).select().from(userPoolGroups).where(eq(userPoolGroups.ownerUserId, ownerUserId)).limit(1)
    if (concurrent[0]) return getUserPool(event, ownerUserId)
    stage = '创建 Sub2API 专属分组'
    const group = record(await sub2ApiAdminFetch(event, '/groups', { method: 'POST', body: {
      name: internalName,
      description: `Managed by Zephyr Hub; pool=${poolId}`,
      subscription_type: 'subscription',
      is_exclusive: true,
      platform: 'openai',
      rate_multiplier: 1,
      fallback_group_id: null,
      fallback_group_id_on_invalid_request: null
    } }))
    upstreamGroupId = numberValue(group.id) || numberValue(record(group.data).id) || 0
    if (!upstreamGroupId) throw new Error('创建分组后未返回 ID')
    stage = '创建 Sub2API 隔离用户'
    const user = record(await sub2ApiAdminFetch(event, '/users', { method: 'POST', body: {
      email: upstreamEmail,
      password: upstreamPassword,
      username: internalName,
      notes: `Managed by Zephyr Hub; pool=${poolId}`,
      role: 'user',
      balance: 0,
      concurrency: 1,
      rpm_limit: 0,
      allowed_groups: [upstreamGroupId]
    } }))
    upstreamUserId = numberValue(user.id) || numberValue(record(user.data).id) || 0
    if (!upstreamUserId) throw new Error('创建用户后未返回 ID')
    stage = '分配 Sub2API 分组订阅'
    await sub2ApiAdminFetch(event, '/subscriptions/assign', { method: 'POST', body: { user_id: upstreamUserId, group_id: upstreamGroupId, notes: `Managed by Zephyr Hub; pool=${poolId}` } })
    stage = '登录 Sub2API 隔离用户'
    const login = record(await sub2ApiUserFetch(event, '/auth/login', { method: 'POST', body: { email: upstreamEmail, password: upstreamPassword } }))
    userAccessToken = text(login.access_token, '')
    if (!userAccessToken) throw new Error(login.requires_2fa ? '隔离用户意外启用了二次验证' : '登录后未返回访问令牌')
    stage = '创建 Sub2API 专属 Key'
    const key = record(await sub2ApiUserFetch(event, '/keys', { method: 'POST', body: { group_id: upstreamGroupId, name: internalName } }, userAccessToken))
    upstreamApiKeyId = numberValue(key.id) || numberValue(record(key.data).id) || 0
    upstreamApiKey = text(key.key || key.api_key || key.token || record(key.data).key || record(key.data).api_key)
    if (!upstreamUserId || !upstreamGroupId || !upstreamApiKeyId || !upstreamApiKey) throw new Error('Sub2API 创建专属池资源返回不完整')
    stage = '保存 Hub 专属号池'
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
      maxAccounts,
      createdBy: actorId || null
    })
    stored = true
  } catch (error) {
    const cleanupErrors: string[] = []
    if (!stored && upstreamUserId) {
      try { await sub2ApiAdminFetch(event, `/users/${upstreamUserId}`, { method: 'DELETE' }) } catch (cleanupError) { cleanupErrors.push(redactSensitiveText(cleanupError instanceof Error ? cleanupError.message : cleanupError)) }
    }
    if (!stored && upstreamGroupId) {
      try { await sub2ApiAdminFetch(event, `/groups/${upstreamGroupId}`, { method: 'DELETE' }) } catch (cleanupError) { cleanupErrors.push(redactSensitiveText(cleanupError instanceof Error ? cleanupError.message : cleanupError)) }
    }
    const message = redactSensitiveText(error instanceof Error ? error.message : '创建专属号池失败') || '创建专属号池失败'
    throw createError({
      statusCode: 502,
      message: `${stage}失败：${message}`,
      data: {
        operationStage: stage,
        reconciliationRequired: Boolean(!stored && (cleanupErrors.length || upstreamUserId || upstreamGroupId)),
        ...(cleanupErrors.length ? { cleanupError: cleanupErrors.join('; ').slice(0, 500) } : {})
      }
    })
  } finally {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lock, lockToken).catch(() => {})
  }
  return getUserPool(event, ownerUserId)
}

export async function startUserPoolOAuth(event: H3Event, ownerUserId: string) {
  await requirePoolEntitlement(event, ownerUserId)
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
  const entitlement = await requirePoolEntitlement(event, ownerUserId)
  const flowId = text(body.flowId)
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(flowId)) throw createError({ statusCode: 400, message: 'OAuth 流程 ID 无效' })
  const callback = parseSub2ApiOpenAiCallback(body.callbackUrl)
  const raw = await useRedis(event).get(oauthKey(flowId))
  let parsedFlow: unknown = null
  try { parsedFlow = raw ? JSON.parse(raw) : null } catch {}
  const flow = record(parsedFlow)
  if (flow.ownerUserId !== ownerUserId || typeof flow.poolId !== 'string' || Number(flow.expiresAt) <= Date.now()) throw createError({ statusCode: 410, message: 'OAuth 授权流程已过期或不属于当前账号' })
  const pool = await resolveOwnedPool(event, ownerUserId, flow.poolId)
  await assertPoolCapacity(event, pool, entitlement.maxAccounts)
  await useRedis(event).del(oauthKey(flowId))
  const created = record(await sub2ApiAdminFetch(event, '/openai/create-from-oauth', { method: 'POST', body: { session_id: flow.sessionId, code: callback.code, state: callback.state, name: text(body.name, '我的 OpenAI 账号'), concurrency: 10, priority: 0, group_ids: [pool.upstreamGroupId], extra: { codex_cli_only: true, codex_fingerprint_mode: 'session' } } }))
  const upstreamAccountId = numberValue(created.id)
  if (!upstreamAccountId) throw createError({ statusCode: 502, message: 'OAuth 账号创建后未返回账号 ID', data: { reconciliationRequired: true } })
  await sub2ApiAdminFetch(event, `/accounts/${upstreamAccountId}`, { method: 'PUT', body: { group_ids: [pool.upstreamGroupId], extra: { codex_cli_only: true, codex_fingerprint_mode: 'session' } } })
  const [account] = await useDatabase(event).insert(userPoolAccounts).values({ ownerUserId, poolGroupId: pool.id, upstreamAccountId, platform: 'openai', accountType: 'oauth', displayName: text(body.name, `账号 ${upstreamAccountId}`), email: text(created.email) || null, status: text(created.status, 'active'), schedulable: false, source: 'oauth' }).returning()
  return account ? publicAccount(account) : null
}

export async function importUserPoolAccount(event: H3Event, ownerUserId: string, body: RecordValue, actorId?: string) {
  const entitlement = await requirePoolEntitlement(event, ownerUserId)
  const pool = await resolveOwnedPool(event, ownerUserId)
  const db = useDatabase(event)
  await assertPoolCapacity(event, pool, entitlement.maxAccounts)
  const credentials = record(body.credentials)
  const parsedCredentials = parseCredentialJson(Buffer.from(JSON.stringify(credentials)))
  const platform = text(body.platform, 'openai')
  const accountType = text(body.type, 'apikey')
  if (!['oauth', 'setup-token', 'apikey', 'upstream', 'bedrock', 'service_account'].includes(accountType)) {
    throw createError({ statusCode: 400, message: '不支持的账号类型' })
  }
  validateSubCredentialAdapter(platform, accountType, parsedCredentials.value)
  const numeric = (value: unknown, fallback: number, min: number, max: number) => {
    const result = value === undefined || value === null || value === '' ? fallback : Number(value)
    if (!Number.isFinite(result) || result < min || result > max) throw createError({ statusCode: 400, message: '账号参数超出有效范围' })
    return result
  }
  const payload: RecordValue = {
    name: text(body.name || body.displayName, `账号 ${Date.now()}`),
    notes: text(body.notes) || null,
    platform,
    type: accountType,
    credentials: parsedCredentials.value,
    extra: { ...record(body.extra), codex_cli_only: true, codex_fingerprint_mode: 'session' },
    concurrency: numeric(body.concurrency, 10, 1, 10_000),
    priority: numeric(body.priority, 0, 0, 1_000_000),
    rate_multiplier: numeric(body.rateMultiplier ?? body.rate_multiplier, 1, 0, 1000),
    group_ids: [pool.upstreamGroupId],
    proxy_id: null,
    expires_at: body.expiresAt ? Math.floor(numeric(body.expiresAt, 0, 1, Number.MAX_SAFE_INTEGER) / (Number(body.expiresAt) > 1e12 ? 1000 : 1)) : null,
    auto_pause_on_expired: body.autoPauseOnExpired !== false
  }
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

export async function importUserPoolAccounts(event: H3Event, ownerUserId: string, rows: unknown[], actorId?: string) {
  if (!rows.length) throw createError({ statusCode: 400, message: '没有可导入的账号' })
  if (rows.length > 100) throw createError({ statusCode: 400, message: '单次最多导入 100 个账号' })
  const created: unknown[] = []
  const failed: Array<{ index: number; name: string; error: string }> = []
  for (const [index, value] of rows.entries()) {
    const row = record(value)
    try {
      const account = await importUserPoolAccount(event, ownerUserId, row, actorId)
      if (account) created.push(account)
    } catch (error) {
      failed.push({ index, name: text(row.displayName || row.name, `账号 ${index + 1}`), error: redactSensitiveText(error instanceof Error ? error.message : '导入失败') })
    }
  }
  return { mode: 'accounts' as const, created, failed }
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
  const removedAt = new Date()
  await useDatabase(event).transaction(async (tx) => {
    await tx.update(smsReceiverBindings).set({ poolAccountId: null, accountEmail: account.email || account.displayName, accountDisplayName: account.displayName, deletedAt: removedAt }).where(eq(smsReceiverBindings.poolAccountId, account.id))
    await tx.update(userPoolAccounts).set({ status: 'removed', schedulable: false, removedAt, updatedAt: removedAt }).where(and(eq(userPoolAccounts.id, account.id), eq(userPoolAccounts.ownerUserId, ownerUserId)))
  })
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
