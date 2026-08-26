import type { H3Event } from 'h3'
import type { Group, HubKey, ServicePlan, UserSubscription } from '../db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { useDatabase } from '../db'
import { groups, hubKeys, usageRollups } from '../db/schema'
import { useRedis } from '../utils/redis'
import { getHubSettings } from './hub-settings'
import { startOfZoned, zonedDateKey, zonedDateStart } from '../utils/time-zone'
import { requireActiveSubscription } from './customer-management'

export const CONCURRENCY_LEASE_TTL_MS = 15 * 60 * 1000
const CONCURRENCY_LEASE_RENEW_MS = 60 * 1000

export interface HubConcurrencyLease {
  id: string
  keyId: string
  groupId: string | null
  scopePrefixes: string[]
  usageCounters: Array<{ key: string; ttl: number }>
  renewAfter: number
}

export interface ChannelConcurrencyLease {
  id: string
  channelId: string
  relayGroupId?: string
  renewAfter: number
}

interface LimitPeriod {
  suffix: string
  requestLimit: number | null
  tokenLimit: number | null
  costLimit: string | null
  ttl: number
  startsAt?: Date
}

interface AdmissionScope {
  kind: 'key' | 'group' | 'subscription'
  id: string
  usageOwnerId?: string
  rpmLimit: number | null
  concurrencyLimit: number | null
  periods: LimitPeriod[]
}

function keyPeriods(key: HubKey, timeZone: string, now = new Date()): LimitPeriod[] {
  const day = zonedDateKey(now, timeZone)
  const week = zonedDateKey(startOfZoned(now, 'week', timeZone), timeZone)
  const month = day.slice(0, 7)
  return [
    { suffix: 'total', requestLimit: key.totalRequestLimit, tokenLimit: key.totalTokenLimit, costLimit: key.totalCostLimit, ttl: 0 },
    { suffix: `day:${day}`, requestLimit: key.dailyRequestLimit, tokenLimit: key.dailyTokenLimit, costLimit: key.dailyCostLimit, ttl: 3 * 24 * 3600 },
    { suffix: `week:${week}`, requestLimit: key.weeklyRequestLimit, tokenLimit: key.weeklyTokenLimit, costLimit: key.weeklyCostLimit, ttl: 10 * 24 * 3600 },
    { suffix: `month:${month}`, requestLimit: key.monthlyRequestLimit, tokenLimit: key.monthlyTokenLimit, costLimit: key.monthlyCostLimit, ttl: 35 * 24 * 3600 }
  ]
}

function groupPeriods(group: Group, timeZone: string, now = new Date()): LimitPeriod[] {
  const day = zonedDateKey(now, timeZone)
  const week = zonedDateKey(startOfZoned(now, 'week', timeZone), timeZone)
  const month = day.slice(0, 7)
  return [
    { suffix: `day:${day}`, requestLimit: group.dailyRequestLimit, tokenLimit: group.dailyTokenLimit, costLimit: group.dailyCostLimit, ttl: 3 * 24 * 3600 },
    { suffix: `week:${week}`, requestLimit: group.weeklyRequestLimit, tokenLimit: group.weeklyTokenLimit, costLimit: group.weeklyCostLimit, ttl: 10 * 24 * 3600 },
    { suffix: `month:${month}`, requestLimit: group.monthlyRequestLimit, tokenLimit: group.monthlyTokenLimit, costLimit: group.monthlyCostLimit, ttl: 35 * 24 * 3600 }
  ]
}

export function subscriptionAdmissionScope(subscription: UserSubscription, plan: ServicePlan, entitlement?: { billingMode?: string; tokenLimit?: number | null; quotaUnit?: string }): AdmissionScope | null {
  const billingMode = entitlement?.billingMode
  if (billingMode === 'unlimited' || billingMode === 'token_metered' || !billingMode && plan.mode === 'unlimited') return null
  const expiresInSeconds = subscription.expiresAt
    ? Math.max(60, Math.ceil((subscription.expiresAt.getTime() - Date.now()) / 1000) + 86400)
    : 0
  return {
    kind: 'subscription',
    id: `${subscription.id}:${subscription.startsAt.getTime()}`,
    usageOwnerId: subscription.userId,
    rpmLimit: null,
    concurrencyLimit: null,
    periods: [{
      suffix: 'cycle',
      requestLimit: null,
      tokenLimit: billingMode === 'token_package' ? entitlement?.tokenLimit ?? plan.tokenLimit : plan.mode === 'token' ? plan.tokenLimit : null,
      costLimit: !billingMode && plan.mode === 'cost' ? plan.costLimit : null,
      ttl: expiresInSeconds,
      startsAt: subscription.startsAt
    }]
  }
}

function admissionScopes(key: HubKey, group: Group | null, timeZone: string): AdmissionScope[] {
  return [
    { kind: 'key', id: key.id, rpmLimit: key.rpmLimit, concurrencyLimit: key.concurrencyLimit, periods: keyPeriods(key, timeZone) },
    ...(group ? [{ kind: 'group' as const, id: group.id, rpmLimit: group.rpmLimit, concurrencyLimit: group.concurrencyLimit, periods: groupPeriods(group, timeZone) }] : [])
  ]
}

function scopePrefix(scope: AdmissionScope) {
  return `hub:${scope.kind}:${scope.id}`
}

function periodStart(period: LimitPeriod, timeZone: string) {
  if (period.startsAt) return period.startsAt
  if (period.suffix === 'total') return null
  const [, value] = period.suffix.split(':')
  if (!value) return null
  return zonedDateStart(period.suffix.startsWith('month:') ? `${value}-01` : value, timeZone)
}

async function periodUsage(event: H3Event | undefined, scope: AdmissionScope, period: LimitPeriod, timeZone: string) {
  const start = periodStart(period, timeZone)
  const dimension = scope.kind === 'key'
    ? eq(usageRollups.keyId, scope.id)
    : scope.kind === 'group'
      ? eq(usageRollups.groupId, scope.id)
      : eq(usageRollups.userId, scope.usageOwnerId!)
  const condition = start
    ? and(dimension, eq(usageRollups.granularity, 'day'), gte(usageRollups.bucketStart, start))
    : and(dimension, eq(usageRollups.granularity, 'day'))
  const [usage] = await useDatabase(event).select({
    requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`,
    tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`,
    cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)`
  }).from(usageRollups).where(condition)
  return { requests: Number(usage?.requests || 0), tokens: Number(usage?.tokens || 0), cost: Number(usage?.cost || 0) }
}

async function hydrateUsageCounters(event: H3Event, scopes: AdmissionScope[], timeZone: string) {
  const redis = useRedis(event)
  for (const scope of scopes) {
    for (const period of scope.periods) {
      const redisKey = `${scopePrefix(scope)}:usage:${period.suffix}`
      if (await redis.exists(redisKey)) continue
      const usage = await periodUsage(event, scope, period, timeZone)
      await redis.hsetnx(redisKey, 'requests', Number(usage?.requests || 0))
      await redis.hsetnx(redisKey, 'tokens', Number(usage?.tokens || 0))
      await redis.hsetnx(redisKey, 'cost', Number(usage?.cost || 0))
      if (period.ttl) await redis.expire(redisKey, period.ttl)
    }
  }
}

const RECONCILE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) > 0 then return 'busy' end
for i = 2, #KEYS do
  local offset = (i - 2) * 4
  redis.call('HSET', KEYS[i], 'requests', ARGV[offset + 2], 'tokens', ARGV[offset + 3], 'cost', ARGV[offset + 4])
  local ttl = tonumber(ARGV[offset + 5])
  if ttl > 0 then redis.call('EXPIRE', KEYS[i], ttl) end
end
return 'ok'
`

export async function reconcileHubUsageCounters(event?: H3Event) {
  const db = useDatabase(event)
  const redis = useRedis(event)
  const settings = await getHubSettings(event)
  const [keys, activeGroups] = await Promise.all([
    db.select().from(hubKeys).where(eq(hubKeys.status, 'active')),
    db.select().from(groups).where(eq(groups.status, 'active'))
  ])
  const scopes: AdmissionScope[] = [
    ...keys.map(key => admissionScopes(key, null, settings.timezone)[0]!),
    ...activeGroups.map(group => ({ kind: 'group' as const, id: group.id, rpmLimit: group.rpmLimit, concurrencyLimit: group.concurrencyLimit, periods: groupPeriods(group, settings.timezone) }))
  ]
  let reconciled = 0
  for (const scope of scopes) {
    const values = await Promise.all(scope.periods.map(period => periodUsage(event, scope, period, settings.timezone)))
    const prefix = scopePrefix(scope)
    const redisKeys = [`${prefix}:concurrency:leases`, ...scope.periods.map(period => `${prefix}:usage:${period.suffix}`)]
    const args: Array<string | number> = [Date.now()]
    for (let index = 0; index < scope.periods.length; index++) {
      const usage = values[index]!
      args.push(usage.requests, usage.tokens, usage.cost, scope.periods[index]!.ttl)
    }
    if (await redis.eval(RECONCILE_SCRIPT, redisKeys.length, ...redisKeys, ...args) === 'ok') reconciled += 1
  }
  return { examined: scopes.length, reconciled }
}

export async function clearHubKeyState(event: H3Event | undefined, keyId: string) {
  const redis = useRedis(event)
  const leaseKey = `hub:key:${keyId}:concurrency:leases`
  await redis.zremrangebyscore(leaseKey, '-inf', Date.now())
  if (await redis.zcard(leaseKey) > 0) return false
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `hub:key:${keyId}:*`, 'COUNT', 100)
    cursor = next
    if (keys.length) await redis.del(...keys)
  } while (cursor !== '0')
  return true
}

export async function clearHubGroupState(event: H3Event | undefined, groupId: string) {
  const redis = useRedis(event)
  const leaseKey = `hub:group:${groupId}:concurrency:leases`
  await redis.zremrangebyscore(leaseKey, '-inf', Date.now())
  if (await redis.zcard(leaseKey) > 0) return false
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `hub:group:${groupId}:*`, 'COUNT', 100)
    cursor = next
    if (keys.length) await redis.del(...keys)
  } while (cursor !== '0')
  return true
}

const ADMIT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'deleting' end
local reservedTokens = tonumber(ARGV[1])
local reservedCost = tonumber(ARGV[2])
local scopeCount = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local leaseExpiresAt = tonumber(ARGV[5])
local leaseId = ARGV[6]
local keyCursor = 2
local argCursor = 7
local parsed = {}
for scopeIndex = 1, scopeCount do
  local scopeKind = ARGV[argCursor]
  local rpmLimit = tonumber(ARGV[argCursor + 1])
  local concurrencyLimit = tonumber(ARGV[argCursor + 2])
  local periodCount = tonumber(ARGV[argCursor + 3])
  argCursor = argCursor + 4
  local rpmKey = KEYS[keyCursor]
  local concurrencyKey = KEYS[keyCursor + 1]
  keyCursor = keyCursor + 2
  redis.call('ZREMRANGEBYSCORE', concurrencyKey, '-inf', now)
  if rpmLimit > 0 and tonumber(redis.call('GET', rpmKey) or '0') >= rpmLimit then return scopeKind .. ':rpm' end
  if concurrencyLimit > 0 and redis.call('ZCARD', concurrencyKey) >= concurrencyLimit then return scopeKind .. ':concurrency' end
  local scope = { kind = scopeKind, rpmKey = rpmKey, concurrencyKey = concurrencyKey, periods = {} }
  for periodIndex = 1, periodCount do
    local usageKey = KEYS[keyCursor]
    keyCursor = keyCursor + 1
    local requestLimit = tonumber(ARGV[argCursor])
    local tokenLimit = tonumber(ARGV[argCursor + 1])
    local costLimit = tonumber(ARGV[argCursor + 2])
    local ttl = tonumber(ARGV[argCursor + 3])
    argCursor = argCursor + 4
    local requests = tonumber(redis.call('HGET', usageKey, 'requests') or '0')
    local tokens = tonumber(redis.call('HGET', usageKey, 'tokens') or '0')
    local cost = tonumber(redis.call('HGET', usageKey, 'cost') or '0')
    if requestLimit > 0 and requests >= requestLimit then return scopeKind .. ':request_quota' end
    if tokenLimit > 0 and tokens + reservedTokens > tokenLimit then return scopeKind .. ':token_quota' end
    if costLimit > 0 and cost + reservedCost > costLimit then return scopeKind .. ':cost_quota' end
    table.insert(scope.periods, { key = usageKey, ttl = ttl })
  end
  table.insert(parsed, scope)
end
for _, scope in ipairs(parsed) do
  redis.call('INCR', scope.rpmKey)
  redis.call('EXPIRE', scope.rpmKey, 60)
  redis.call('ZADD', scope.concurrencyKey, leaseExpiresAt, leaseId)
  redis.call('PEXPIRE', scope.concurrencyKey, leaseExpiresAt - now + 60000)
  for _, period in ipairs(scope.periods) do
    redis.call('HINCRBY', period.key, 'requests', 1)
    redis.call('HINCRBY', period.key, 'tokens', reservedTokens)
    redis.call('HINCRBYFLOAT', period.key, 'cost', reservedCost)
    if period.ttl > 0 then redis.call('EXPIRE', period.key, period.ttl) end
  end
end
return 'ok'
`

export async function admitHubRequest(event: H3Event, key: HubKey, group: Group | null, reservedTokens: number, reservedCost: number, options: { skipSubscriptionQuota?: boolean; scopeMode?: 'all' | 'base_only' | 'subscription_only' } = {}) {
  const settings = await getHubSettings(event)
  const scopeMode = options.scopeMode || 'all'
  const scopes = scopeMode === 'subscription_only' ? [] : admissionScopes(key, group, settings.timezone)
  if (key.ownerUserId && scopeMode !== 'base_only' && !options.skipSubscriptionQuota) {
    const { subscription, plan } = await requireActiveSubscription(event, key.ownerUserId)
    const snapshot = subscription.entitlementSnapshot as { billingMode?: string; tokenLimit?: number | null } | null
    const planScope = subscriptionAdmissionScope(subscription, plan, snapshot || undefined)
    if (planScope && !options.skipSubscriptionQuota) scopes.push(planScope)
  }
  await hydrateUsageCounters(event, scopes, settings.timezone)
  const redis = useRedis(event)
  const now = Date.now()
  const minute = Math.floor(now / 60000)
  const leaseId = typeof event.context.hubRequestId === 'string' ? event.context.hubRequestId : crypto.randomUUID()
  const keys = [`hub:key:${key.id}:deleting`]
  const args: Array<string | number> = [
    Math.max(0, Math.round(reservedTokens)),
    Math.max(0, reservedCost),
    scopes.length,
    now,
    now + CONCURRENCY_LEASE_TTL_MS,
    leaseId
  ]
  for (const scope of scopes) {
    const prefix = scopePrefix(scope)
    keys.push(`${prefix}:rpm:${minute}`, `${prefix}:concurrency:leases`, ...scope.periods.map(period => `${prefix}:usage:${period.suffix}`))
    args.push(scope.kind, scope.rpmLimit || 0, scope.concurrencyLimit || 0, scope.periods.length)
    for (const period of scope.periods) args.push(period.requestLimit || 0, period.tokenLimit || 0, period.costLimit || 0, period.ttl)
  }
  const result = await redis.eval(ADMIT_SCRIPT, keys.length, ...keys, ...args)
  if (result === 'ok') {
    return {
      id: leaseId,
      keyId: key.id,
      groupId: group?.id || null,
      scopePrefixes: scopes.map(scopePrefix),
      usageCounters: scopes.flatMap(scope => scope.periods.map(period => ({ key: `${scopePrefix(scope)}:usage:${period.suffix}`, ttl: period.ttl }))),
      renewAfter: now + CONCURRENCY_LEASE_RENEW_MS
    }
  }
  if (result === 'deleting') throw createError({ statusCode: 401, message: 'Hub Key 已停用' })
  const messages: Record<string, string> = {
    rpm: '已达到每分钟请求限制',
    concurrency: '已达到最大并发限制',
    request_quota: '请求次数额度已用尽',
    token_quota: 'Token 额度已用尽',
    cost_quota: '金额额度已用尽'
  }
  const raw = String(result)
  const [scope, reason] = raw.split(':')
  const label = scope === 'group' ? '所属分组' : scope === 'subscription' ? '当前套餐' : 'Hub Key'
  throw createError({ statusCode: 429, message: `${label}${messages[reason || ''] || '已达到使用限制'}` })
}

const BEGIN_DELETION_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[2]) > 0 then return 0 end
if not redis.call('SET', KEYS[1], '1', 'EX', 300, 'NX') then return 0 end
return 1
`

export async function beginHubKeyDeletion(event: H3Event, keyId: string) {
  return Number(await useRedis(event).eval(
    BEGIN_DELETION_SCRIPT,
    2,
    `hub:key:${keyId}:deleting`,
    `hub:key:${keyId}:concurrency:leases`,
    Date.now()
  )) === 1
}

export async function cancelHubKeyDeletion(event: H3Event, keyId: string) {
  await useRedis(event).del(`hub:key:${keyId}:deleting`)
}

export async function settleHubRequest(
  event: H3Event,
  key: HubKey,
  group: Group | null,
  totalTokens: number,
  cost: number,
  reservedTokens: number,
  reservedCost: number,
  lease: HubConcurrencyLease
) {
  const redis = useRedis(event)
  const transaction = redis.multi()
  for (const prefix of lease.scopePrefixes) {
    transaction.zrem(`${prefix}:concurrency:leases`, lease.id)
  }
  for (const counter of lease.usageCounters) {
    transaction.hincrby(counter.key, 'tokens', Math.round(totalTokens) - Math.round(reservedTokens))
    transaction.hincrbyfloat(counter.key, 'cost', cost - reservedCost)
    if (counter.ttl) transaction.expire(counter.key, counter.ttl)
  }
  await transaction.exec()
}

export async function cancelHubAdmission(event: H3Event, lease: HubConcurrencyLease, reservedTokens: number, reservedCost: number) {
  const transaction = useRedis(event).multi()
  for (const prefix of lease.scopePrefixes) transaction.zrem(`${prefix}:concurrency:leases`, lease.id)
  for (const counter of lease.usageCounters) {
    transaction.hincrby(counter.key, 'requests', -1)
    transaction.hincrby(counter.key, 'tokens', -Math.round(reservedTokens))
    transaction.hincrbyfloat(counter.key, 'cost', -reservedCost)
    if (counter.ttl) transaction.expire(counter.key, counter.ttl)
  }
  await transaction.exec()
}

export async function renewHubConcurrency(event: H3Event, lease: HubConcurrencyLease) {
  const now = Date.now()
  if (lease.renewAfter > now) return
  const redis = useRedis(event)
  const transaction = redis.multi()
  for (const prefix of lease.scopePrefixes) {
    const redisKey = `${prefix}:concurrency:leases`
    transaction.zadd(redisKey, 'XX', now + CONCURRENCY_LEASE_TTL_MS, lease.id)
    transaction.pexpire(redisKey, CONCURRENCY_LEASE_TTL_MS + 60000)
  }
  await transaction.exec()
  lease.renewAfter = now + CONCURRENCY_LEASE_RENEW_MS
}

export async function releaseHubConcurrency(event: H3Event, lease: HubConcurrencyLease) {
  const transaction = useRedis(event).multi()
  for (const prefix of lease.scopePrefixes) transaction.zrem(`${prefix}:concurrency:leases`, lease.id)
  await transaction.exec()
}

const ACQUIRE_CHANNEL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[1]) then return 0 end
local groupMax = tonumber(ARGV[2])
if groupMax > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[3])
  if redis.call('ZCARD', KEYS[3]) >= groupMax then return 0 end
end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[4] - ARGV[3] + 60000)
if groupMax > 0 then
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5])
  redis.call('PEXPIRE', KEYS[3], ARGV[4] - ARGV[3] + 60000)
end
return 1
`

export async function acquireChannel(event: H3Event, channelId: string, max: number, relayGroup?: { id: string; max: number | null }) {
  const redis = useRedis(event)
  const now = Date.now()
  const leaseId = crypto.randomUUID()
  const acquired = Number(await redis.eval(
    ACQUIRE_CHANNEL_SCRIPT,
    3,
    `hub:channel:${channelId}:deleting`,
    `hub:channel:${channelId}:concurrency:leases`,
    `hub:relay-group:${relayGroup?.id || 'none'}:concurrency:leases`,
    max,
    relayGroup?.max || 0,
    now,
    now + CONCURRENCY_LEASE_TTL_MS,
    leaseId
  )) === 1
  return acquired ? { id: leaseId, channelId, relayGroupId: relayGroup?.max ? relayGroup.id : undefined, renewAfter: now + CONCURRENCY_LEASE_RENEW_MS } : null
}

export async function renewChannel(event: H3Event, lease: ChannelConcurrencyLease) {
  const now = Date.now()
  if (lease.renewAfter > now) return
  const key = `hub:channel:${lease.channelId}:concurrency:leases`
  const transaction = useRedis(event).multi()
  transaction.zadd(key, 'XX', now + CONCURRENCY_LEASE_TTL_MS, lease.id)
  transaction.pexpire(key, CONCURRENCY_LEASE_TTL_MS + 60000)
  if (lease.relayGroupId) {
    const groupKey = `hub:relay-group:${lease.relayGroupId}:concurrency:leases`
    transaction.zadd(groupKey, 'XX', now + CONCURRENCY_LEASE_TTL_MS, lease.id)
    transaction.pexpire(groupKey, CONCURRENCY_LEASE_TTL_MS + 60000)
  }
  await transaction.exec()
  lease.renewAfter = now + CONCURRENCY_LEASE_RENEW_MS
}

export async function releaseChannel(event: H3Event, lease: ChannelConcurrencyLease) {
  const transaction = useRedis(event).multi()
  transaction.zrem(`hub:channel:${lease.channelId}:concurrency:leases`, lease.id)
  if (lease.relayGroupId) transaction.zrem(`hub:relay-group:${lease.relayGroupId}:concurrency:leases`, lease.id)
  await transaction.exec()
}

export async function beginChannelDeletion(event: H3Event, channelId: string) {
  return Number(await useRedis(event).eval(
    BEGIN_DELETION_SCRIPT,
    2,
    `hub:channel:${channelId}:deleting`,
    `hub:channel:${channelId}:concurrency:leases`,
    Date.now()
  )) === 1
}

export async function finishChannelDeletion(event: H3Event, channelId: string) {
  await useRedis(event).del(
    `hub:channel:${channelId}:deleting`,
    `hub:channel:${channelId}:concurrency:leases`,
    `hub:channel:${channelId}:concurrency`
  )
}
