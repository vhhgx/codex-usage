import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelModels, channels, groupChannelRules, groupMemberships, groupModelRules, groups, hubKeys, modelPrices, requestLogs, usageRollups } from '../db/schema'
import { hubKeyUsageDetail, requestLogDetail } from './hub-analytics'
import { createHubKeyRecord, listHubKeys, revealHubKeySecret, updateHubKeyRecord } from './hub-admin'
import { getHubSettings } from './hub-settings'
import { startOfZoned } from '../utils/time-zone'
import { beginHubKeyDeletion, cancelHubKeyDeletion } from './hub-limits'
import { deleteHubKeyPreservingRollups } from './hub-deletion'
import { assignDefaultGroup, DEFAULT_GROUP_ID, ensureDefaultSubscription, getUserPlan, listAnnouncements } from './customer-management'

function number(value: unknown) { return Number(value || 0) }

export async function listUserKeys(event: H3Event, userId: string) {
  return (await listHubKeys(event)).filter(key => key.ownerUserId === userId)
}

export async function createUserKey(event: H3Event, userId: string, body: Record<string, unknown>) {
  const allowed = new Set(['name', 'note', 'key'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能设置字段：${invalid.join(', ')}` })
  await assignDefaultGroup(event, userId)
  await ensureDefaultSubscription(event, userId)
  return createHubKeyRecord(event, { name: body.name, note: body.note, key: body.key, ownerUserId: userId, groupId: DEFAULT_GROUP_ID }, userId)
}

export async function getUserKey(event: H3Event, userId: string, id: string) {
  const [key] = await useDatabase(event).select({ id: hubKeys.id }).from(hubKeys)
    .where(eq(hubKeys.id, id)).limit(1)
  const view = key ? (await listUserKeys(event, userId)).find(item => item.id === id) : null
  if (!view) throw createError({ statusCode: 404, message: 'Key 不存在' })
  return view
}

export async function updateUserKey(event: H3Event, userId: string, id: string, body: Record<string, unknown>) {
  await getUserKey(event, userId, id)
  const allowed = new Set(['name', 'note', 'status'])
  const invalid = Object.keys(body).filter(key => !allowed.has(key))
  if (invalid.length) throw createError({ statusCode: 400, message: `用户不能修改字段：${invalid.join(', ')}` })
  if ('status' in body && body.status !== 'active' && body.status !== 'disabled') throw createError({ statusCode: 400, message: 'Key 状态不正确' })
  return updateHubKeyRecord(event, id, body)
}

export async function revealUserKey(event: H3Event, userId: string, id: string) {
  await getUserKey(event, userId, id)
  return revealHubKeySecret(event, id)
}

export async function deleteUserKey(event: H3Event, userId: string, id: string) {
  await getUserKey(event, userId, id)
  if (!await beginHubKeyDeletion(event, id)) throw createError({ statusCode: 409, message: 'Key 仍有进行中的请求，请停用后稍候再删除' })
  try {
    await deleteHubKeyPreservingRollups(event, id)
    return { success: true }
  } catch (error) {
    await cancelHubKeyDeletion(event, id)
    throw error
  }
}

export async function getUserGroups(event: H3Event, userId: string) {
  const db = useDatabase(event)
  const settings = await getHubSettings(event)
  const now = new Date()
  const starts = { today: startOfZoned(now, 'day', settings.timezone), week: startOfZoned(now, 'week', settings.timezone), month: startOfZoned(now, 'month', settings.timezone) }
  const rows = await db.select({ group: groups }).from(groupMemberships)
    .innerJoin(groups, eq(groupMemberships.groupId, groups.id))
    .where(eq(groupMemberships.userId, userId)).orderBy(asc(groups.name))
  const usage = rows.length ? await db.select({
    groupId: usageRollups.groupId,
    requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`, tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)`,
    todayRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.today.toISOString()}::timestamptz), 0)`, todayTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.today.toISOString()}::timestamptz), 0)`, todayCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.today.toISOString()}::timestamptz), 0)`,
    weekRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.week.toISOString()}::timestamptz), 0)`, weekTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.week.toISOString()}::timestamptz), 0)`, weekCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.week.toISOString()}::timestamptz), 0)`,
    monthRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.month.toISOString()}::timestamptz), 0)`, monthTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.month.toISOString()}::timestamptz), 0)`, monthCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.month.toISOString()}::timestamptz), 0)`
  }).from(usageRollups).where(and(eq(usageRollups.granularity, 'day'), inArray(usageRollups.groupId, rows.map(row => row.group.id))))
    .groupBy(usageRollups.groupId) : []
  const usageByGroup = new Map(usage.map(item => [item.groupId, item]))
  return rows.map(({ group }) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    status: group.status,
    allowedEndpoints: group.allowedEndpoints,
    rpmLimit: group.rpmLimit,
    concurrencyLimit: group.concurrencyLimit,
    dailyRequestLimit: group.dailyRequestLimit,
    dailyTokenLimit: group.dailyTokenLimit,
    dailyCostLimit: group.dailyCostLimit === null ? null : Number(group.dailyCostLimit),
    weeklyRequestLimit: group.weeklyRequestLimit,
    weeklyTokenLimit: group.weeklyTokenLimit,
    weeklyCostLimit: group.weeklyCostLimit === null ? null : Number(group.weeklyCostLimit),
    monthlyRequestLimit: group.monthlyRequestLimit,
    monthlyTokenLimit: group.monthlyTokenLimit,
    monthlyCostLimit: group.monthlyCostLimit === null ? null : Number(group.monthlyCostLimit),
    priceMultiplier: Number(group.priceMultiplier),
    usage: (() => {
      const row = usageByGroup.get(group.id)
      const period = (prefix: 'today' | 'week' | 'month') => ({ requests: number(row?.[`${prefix}Requests`]), tokens: number(row?.[`${prefix}Tokens`]), cost: number(row?.[`${prefix}Cost`]) })
      return { requests: number(row?.requests), tokens: number(row?.tokens), cost: number(row?.cost), today: period('today'), week: period('week'), month: period('month') }
    })()
  }))
}

export async function getUserOverview(event: H3Event, userId: string) {
  const db = useDatabase(event)
  const settings = await getHubSettings(event)
  const now = new Date()
  const starts = {
    today: startOfZoned(now, 'day', settings.timezone),
    week: startOfZoned(now, 'week', settings.timezone),
    month: startOfZoned(now, 'month', settings.timezone)
  }
  const [totals] = await db.select({
    todayRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.today.toISOString()}::timestamptz), 0)`,
    todayTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.today.toISOString()}::timestamptz), 0)`,
    todayCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.today.toISOString()}::timestamptz), 0)`,
    weekRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.week.toISOString()}::timestamptz), 0)`,
    weekTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.week.toISOString()}::timestamptz), 0)`,
    weekCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.week.toISOString()}::timestamptz), 0)`,
    monthRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${starts.month.toISOString()}::timestamptz), 0)`,
    monthTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${starts.month.toISOString()}::timestamptz), 0)`,
    monthCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${starts.month.toISOString()}::timestamptz), 0)`
  }).from(usageRollups).where(and(eq(usageRollups.userId, userId), eq(usageRollups.granularity, 'day')))
  const keys = await listUserKeys(event, userId)
  const groups = await getUserGroups(event, userId)
  const models = await getUserModels(event, userId)
  const [plan, announcements] = await Promise.all([getUserPlan(event, userId), listAnnouncements(event, true)])
  const period = (id: 'today' | 'week' | 'month') => ({ requests: number(totals?.[`${id}Requests`]), tokens: number(totals?.[`${id}Tokens`]), cost: number(totals?.[`${id}Cost`]) })
  const healthy = await db.select({ value: count() }).from(channels).where(and(eq(channels.enabled, true), eq(channels.healthStatus, 'healthy')))
  const enabled = await db.select({ value: count() }).from(channels).where(eq(channels.enabled, true))
  return {
    periods: { today: period('today'), week: period('week'), month: period('month') },
    keys,
    groups,
    models: models.slice(0, 12),
    plan,
    announcements,
    service: { status: number(healthy[0]?.value) > 0 ? 'available' : 'degraded', healthyChannels: number(healthy[0]?.value), enabledChannels: number(enabled[0]?.value) }
  }
}

export async function getUserUsage(event: H3Event, userId: string) {
  const keys = await listUserKeys(event, userId)
  return { keys: await Promise.all(keys.map(async key => ({ key, ...(await hubKeyUsageDetail(event, key.id)) }))) }
}

export async function getUserModels(event: H3Event, userId: string) {
  const db = useDatabase(event)
  const memberships = await db.select({ groupId: groups.id, groupEndpoints: groups.allowedEndpoints }).from(groupMemberships)
    .innerJoin(groups, and(eq(groupMemberships.groupId, groups.id), eq(groups.status, 'active')))
    .where(eq(groupMemberships.userId, userId))
  if (!memberships.length) return []
  const groupIds = memberships.map(item => item.groupId)
  const [modelRules, channelRules, modelRows, priceRows] = await Promise.all([
    db.select().from(groupModelRules).where(inArray(groupModelRules.groupId, groupIds)),
    db.select().from(groupChannelRules).where(inArray(groupChannelRules.groupId, groupIds)),
    db.select({ publicModel: channelModels.publicModel, endpoints: channelModels.endpoints, channelId: channels.id }).from(channelModels).innerJoin(channels, eq(channelModels.channelId, channels.id)).where(and(eq(channelModels.enabled, true), eq(channels.enabled, true), eq(channels.healthStatus, 'healthy'))),
    db.select().from(modelPrices).where(lte(modelPrices.effectiveAt, new Date())).orderBy(desc(modelPrices.effectiveAt))
  ])
  const result = new Map<string, Set<string>>()
  const endpointUniverse = ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/images/generations', '/v1/images/edits']
  for (const membership of memberships) {
    const groupId = membership.groupId
    const allowedModels = new Set(modelRules.filter(rule => rule.groupId === groupId).map(rule => rule.publicModel))
    const groupChannels = channelRules.filter(rule => rule.groupId === groupId)
    const allowedChannels = new Set(groupChannels.filter(rule => rule.enabled).map(rule => rule.channelId))
    for (const row of modelRows) {
      if (allowedModels.size && !allowedModels.has(row.publicModel)) continue
      if (groupChannels.length && !allowedChannels.has(row.channelId)) continue
      if (!result.has(row.publicModel)) result.set(row.publicModel, new Set())
      const candidateEndpoints = row.endpoints.length ? row.endpoints : endpointUniverse
      candidateEndpoints
        .filter(endpoint => !membership.groupEndpoints.length || membership.groupEndpoints.includes(endpoint))
        .forEach(endpoint => result.get(row.publicModel)!.add(endpoint))
    }
  }
  const latestPrices = new Map<string, typeof priceRows[number]>()
  priceRows.forEach(price => { if (!latestPrices.has(price.publicModel)) latestPrices.set(price.publicModel, price) })
  return [...result.entries()].filter(([, endpoints]) => endpoints.size > 0).sort(([left], [right]) => left.localeCompare(right)).map(([id, endpoints]) => {
    const price = latestPrices.get(id)
    return { id, endpoints: [...endpoints], pricing: price ? { inputPerMillion: Number(price.inputPerMillion), outputPerMillion: Number(price.outputPerMillion), cachedPerMillion: Number(price.cachedPerMillion), reasoningPerMillion: Number(price.reasoningPerMillion), imagePrices: price.imagePrices } : null }
  })
}

export async function listUserLogs(event: H3Event, userId: string, page = 1, pageSize = 50) {
  const db = useDatabase(event)
  const size = Math.min(100, Math.max(10, pageSize))
  const rows = await db.select({ log: requestLogs, keyName: hubKeys.name }).from(requestLogs)
    .leftJoin(hubKeys, eq(requestLogs.keyId, hubKeys.id)).where(eq(requestLogs.userId, userId))
    .orderBy(desc(requestLogs.createdAt)).limit(size).offset((Math.max(1, page) - 1) * size)
  const [total] = await db.select({ value: count() }).from(requestLogs).where(eq(requestLogs.userId, userId))
  return { items: rows.map(({ log, keyName }) => ({ id: log.id, requestId: log.requestId, keyId: log.keyId, keyName, endpoint: log.endpoint, requestedModel: log.requestedModel, upstreamModel: log.upstreamModel, channelId: null, channelName: null, status: log.status, httpStatus: log.httpStatus, totalTokens: log.totalTokens, cost: Number(log.cost), firstByteMs: log.firstByteMs, durationMs: log.durationMs, streaming: log.streaming, errorMessage: log.errorMessage, createdAt: log.createdAt.getTime() })), page: Math.max(1, page), pageSize: size, total: number(total?.value) }
}

export async function getUserLog(event: H3Event, userId: string, id: string) {
  const [owned] = await useDatabase(event).select({ id: requestLogs.id }).from(requestLogs).where(and(eq(requestLogs.id, id), eq(requestLogs.userId, userId))).limit(1)
  if (!owned) throw createError({ statusCode: 404, message: '请求日志不存在' })
  const detail = await requestLogDetail(event, id)
  return { ...detail, channelId: null, channelName: null, attempts: [] }
}
