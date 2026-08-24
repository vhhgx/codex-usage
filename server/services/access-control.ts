import argon2 from 'argon2'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { HubGroupView, HubUserView, UserRole, UserStatus } from '#shared/types/access-control'
import { useDatabase, withDatabaseTransaction } from '../db'
import {
  groupChannelRules,
  groupMemberships,
  groupModelRules,
  groups,
  channels,
  hubKeys,
  requestLogs,
  usageRollups,
  users
} from '../db/schema'
import { clearHubGroupState } from './hub-limits'
import { assignDefaultGroup, assignPlan, DEFAULT_GROUP_ID, ensureDefaultSubscription } from './customer-management'
import { maskHubKey } from '#shared/utils/key-display'

type UnknownRecord = Record<string, unknown>
const USER_ROLES = new Set<UserRole>(['super_admin', 'admin', 'operator', 'auditor', 'user'])
const USER_STATUSES = new Set<UserStatus>(['active', 'disabled', 'locked'])

function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function nullableInteger(value: unknown, min = 0) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) throw createError({ statusCode: 400, message: '限制值格式不正确' })
  return parsed
}

function nullableMoney(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw createError({ statusCode: 400, message: '金额限制格式不正确' })
  return String(parsed)
}

function idArray(value: unknown, max = 1000) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => text(item, 100)).filter(Boolean))].slice(0, max)
}

function stringArray(value: unknown, max = 500) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => text(item, 200)).filter(Boolean))].slice(0, max)
}

function channelRuleArray(value: unknown) {
  if (!Array.isArray(value)) throw createError({ statusCode: 400, message: 'channelRules 必须是数组' })
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw createError({ statusCode: 400, message: '渠道规则格式不正确' })
    }
    const rule = item as UnknownRecord
    const channelId = text(rule.channelId, 100)
    if (!channelId || seen.has(channelId)) throw createError({ statusCode: 400, message: '渠道规则包含空值或重复渠道' })
    seen.add(channelId)
    return {
      channelId,
      enabled: rule.enabled !== false,
      priorityOverride: nullableInteger(rule.priorityOverride, 0),
      weightOverride: nullableInteger(rule.weightOverride, 1)
    }
  }).slice(0, 1000)
}

async function accessSnapshot(event: H3Event) {
  const db = useDatabase(event)
  const [userRows, groupRows, membershipRows, modelRows, channelRows, keyRows, groupUsageRows] = await Promise.all([
    db.select().from(users).orderBy(asc(users.username)),
    db.select().from(groups).orderBy(asc(groups.name)),
    db.select().from(groupMemberships),
    db.select().from(groupModelRules),
    db.select().from(groupChannelRules),
    db.select({ id: hubKeys.id, ownerUserId: hubKeys.ownerUserId, groupId: hubKeys.groupId }).from(hubKeys),
    db.select({ groupId: usageRollups.groupId, requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`, tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)` }).from(usageRollups).where(eq(usageRollups.granularity, 'day')).groupBy(usageRollups.groupId)
  ])
  return { userRows, groupRows, membershipRows, modelRows, channelRows, keyRows, groupUsageRows }
}

export async function listUsers(event: H3Event): Promise<HubUserView[]> {
  const snapshot = await accessSnapshot(event)
  const groupNames = new Map(snapshot.groupRows.map(group => [group.id, group.name]))
  return snapshot.userRows.map(user => {
    const memberships = snapshot.membershipRows.filter(item => item.userId === user.id)
    const groupIds = memberships.map(item => item.groupId)
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt?.getTime() || null,
      passwordChangedAt: user.passwordChangedAt?.getTime() || null,
      createdAt: user.createdAt.getTime(),
      updatedAt: user.updatedAt.getTime(),
      groupIds,
      groupNames: groupIds.map(id => groupNames.get(id)).filter((name): name is string => Boolean(name)),
      keyCount: snapshot.keyRows.filter(key => key.ownerUserId === user.id).length
    }
  })
}

export async function getUser(event: H3Event, id: string) {
  const user = (await listUsers(event)).find(item => item.id === id)
  if (!user) throw createError({ statusCode: 404, message: '用户不存在' })
  return user
}

export async function getUserDetail(event: H3Event, id: string) {
  const user = await getUser(event, id)
  const db = useDatabase(event)
  const [keys, [usage], recent] = await Promise.all([
    db.select({ id: hubKeys.id, name: hubKeys.name, keyPrefix: hubKeys.keyPrefix, keyLastFour: hubKeys.keyLastFour, status: hubKeys.status, groupId: hubKeys.groupId, lastUsedAt: hubKeys.lastUsedAt }).from(hubKeys).where(eq(hubKeys.ownerUserId, id)).orderBy(asc(hubKeys.name)),
    db.select({ requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`, tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`, cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)` }).from(usageRollups).where(and(eq(usageRollups.userId, id), eq(usageRollups.granularity, 'day'))),
    db.select({ id: requestLogs.id, requestId: requestLogs.requestId, model: requestLogs.requestedModel, status: requestLogs.status, httpStatus: requestLogs.httpStatus, createdAt: requestLogs.createdAt }).from(requestLogs).where(eq(requestLogs.userId, id)).orderBy(desc(requestLogs.createdAt)).limit(10)
  ])
  return {
    user,
    usage: { requests: Number(usage?.requests || 0), tokens: Number(usage?.tokens || 0), cost: Number(usage?.cost || 0) },
    keys: keys.map(key => ({ ...key, maskedKey: maskHubKey(key.keyPrefix, key.keyLastFour), lastUsedAt: key.lastUsedAt?.getTime() || null })),
    recent: recent.map(item => ({ ...item, createdAt: item.createdAt.getTime() }))
  }
}

async function assertGroupsExist(event: H3Event, groupIds: string[]) {
  if (!groupIds.length) return
  const rows = await useDatabase(event).select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds))
  if (rows.length !== groupIds.length) throw createError({ statusCode: 400, message: '包含不存在的分组' })
}

export async function syncUserGroups(event: H3Event, userId: string, groupIds: string[], actorId: string) {
  const user = await getUser(event, userId)
  if (user.role === 'user') {
    await assignDefaultGroup(event, userId, actorId)
    return getUser(event, userId)
  }
  await assertGroupsExist(event, groupIds)
  const ownedKeys = await useDatabase(event).select({ id: hubKeys.id, groupId: hubKeys.groupId })
    .from(hubKeys).where(eq(hubKeys.ownerUserId, userId))
  const protectedGroup = ownedKeys.find(key => key.groupId && !groupIds.includes(key.groupId))
  if (protectedGroup) throw createError({
    statusCode: 409,
    message: '该用户仍有 Key 归属于待移除分组，请先转移或删除相关 Key'
  })
  await withDatabaseTransaction(event, async () => {
    const db = useDatabase(event)
    await db.delete(groupMemberships).where(eq(groupMemberships.userId, userId))
    if (groupIds.length) await db.insert(groupMemberships).values(groupIds.map(groupId => ({ groupId, userId, createdBy: actorId })))
  })
  return getUser(event, userId)
}

export async function createUserRecord(event: H3Event, body: UnknownRecord, actorId: string) {
  const username = text(body.username, 120)
  const password = typeof body.password === 'string' ? body.password : ''
  const role = USER_ROLES.has(body.role as UserRole) ? body.role as UserRole : 'user'
  if (!username || password.length < 8) throw createError({ statusCode: 400, message: '用户名必填，初始密码至少 8 位' })
  const email = text(body.email, 320) || null
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw createError({ statusCode: 400, message: '邮箱格式不正确' })
  const db = useDatabase(event)
  const [created] = await db.insert(users).values({
    username,
    displayName: text(body.displayName, 120) || null,
    email,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    role,
    status: 'active',
    mustChangePassword: role === 'user',
    passwordChangedAt: null
  }).returning({ id: users.id })
  if (!created) throw createError({ statusCode: 500, message: '创建用户失败' })
  if (role === 'user') {
    await assignDefaultGroup(event, created.id, actorId)
    const planId = text(body.planId, 100)
    if (planId) await assignPlan(event, created.id, planId, undefined, actorId)
    else await ensureDefaultSubscription(event, created.id, actorId)
  } else {
    await syncUserGroups(event, created.id, idArray(body.groupIds), actorId)
  }
  return getUser(event, created.id)
}

export async function updateUserRecord(event: H3Event, id: string, body: UnknownRecord, actorId: string) {
  const current = await getUser(event, id)
  const role = body.role === undefined ? current.role : USER_ROLES.has(body.role as UserRole) ? body.role as UserRole : null
  const status = body.status === undefined ? current.status : USER_STATUSES.has(body.status as UserStatus) ? body.status as UserStatus : null
  if (!role || !status) throw createError({ statusCode: 400, message: '用户角色或状态不正确' })
  const email = body.email === undefined ? current.email : text(body.email, 320) || null
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw createError({ statusCode: 400, message: '邮箱格式不正确' })
  await useDatabase(event).update(users).set({
    username: body.username === undefined ? current.username : text(body.username, 120) || current.username,
    displayName: body.displayName === undefined ? current.displayName : text(body.displayName, 120) || null,
    email,
    role,
    status,
    updatedAt: new Date()
  }).where(eq(users.id, id))
  if (role === 'user') {
    await assignDefaultGroup(event, id, actorId)
    const planId = text(body.planId, 100)
    if (planId) await assignPlan(event, id, planId, undefined, actorId)
    else await ensureDefaultSubscription(event, id, actorId)
  }
  else if ('groupIds' in body) await syncUserGroups(event, id, idArray(body.groupIds), actorId)
  return getUser(event, id)
}

export async function resetUserPassword(event: H3Event, id: string, password: string) {
  if (password.length < 8) throw createError({ statusCode: 400, message: '新密码至少 8 位' })
  const current = await getUser(event, id)
  await useDatabase(event).update(users).set({
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    passwordChangedAt: new Date(),
    mustChangePassword: current.role === 'user',
    status: 'active',
    updatedAt: new Date()
  }).where(eq(users.id, id))
  return { success: true }
}

export async function deleteUserRecord(event: H3Event, id: string) {
  const current = await getUser(event, id)
  if (current.keyCount) throw createError({ statusCode: 409, message: '用户仍有 Hub Key，请先转移或删除 Key' })
  if (current.role === 'super_admin') {
    const admins = (await listUsers(event)).filter(user => user.role === 'super_admin' && user.id !== id)
    if (!admins.length) throw createError({ statusCode: 409, message: '不能删除最后一个超级管理员' })
  }
  await useDatabase(event).delete(users).where(eq(users.id, id))
  return { success: true }
}

function groupValues(body: UnknownRecord, existing?: HubGroupView) {
  const price = body.priceMultiplier === undefined ? existing?.priceMultiplier ?? 1 : Number(body.priceMultiplier)
  if (!Number.isFinite(price) || price < 0) throw createError({ statusCode: 400, message: '价格倍率格式不正确' })
  return {
    name: body.name === undefined ? existing?.name || '' : text(body.name, 120),
    description: body.description === undefined ? existing?.description || null : text(body.description, 1000) || null,
    status: body.status === 'disabled' ? 'disabled' as const : body.status === 'active' ? 'active' as const : existing?.status || 'active' as const,
    allowedEndpoints: body.allowedEndpoints === undefined ? existing?.allowedEndpoints || [] : stringArray(body.allowedEndpoints, 30),
    rpmLimit: body.rpmLimit === undefined ? existing?.rpmLimit ?? null : nullableInteger(body.rpmLimit, 1),
    concurrencyLimit: body.concurrencyLimit === undefined ? existing?.concurrencyLimit ?? null : nullableInteger(body.concurrencyLimit, 1),
    dailyRequestLimit: body.dailyRequestLimit === undefined ? existing?.dailyRequestLimit ?? null : nullableInteger(body.dailyRequestLimit, 1),
    dailyTokenLimit: body.dailyTokenLimit === undefined ? existing?.dailyTokenLimit ?? null : nullableInteger(body.dailyTokenLimit, 1),
    dailyCostLimit: body.dailyCostLimit === undefined ? existing?.dailyCostLimit === null || existing?.dailyCostLimit === undefined ? null : String(existing.dailyCostLimit) : nullableMoney(body.dailyCostLimit),
    weeklyRequestLimit: body.weeklyRequestLimit === undefined ? existing?.weeklyRequestLimit ?? null : nullableInteger(body.weeklyRequestLimit, 1),
    weeklyTokenLimit: body.weeklyTokenLimit === undefined ? existing?.weeklyTokenLimit ?? null : nullableInteger(body.weeklyTokenLimit, 1),
    weeklyCostLimit: body.weeklyCostLimit === undefined ? existing?.weeklyCostLimit === null || existing?.weeklyCostLimit === undefined ? null : String(existing.weeklyCostLimit) : nullableMoney(body.weeklyCostLimit),
    monthlyRequestLimit: body.monthlyRequestLimit === undefined ? existing?.monthlyRequestLimit ?? null : nullableInteger(body.monthlyRequestLimit, 1),
    monthlyTokenLimit: body.monthlyTokenLimit === undefined ? existing?.monthlyTokenLimit ?? null : nullableInteger(body.monthlyTokenLimit, 1),
    monthlyCostLimit: body.monthlyCostLimit === undefined ? existing?.monthlyCostLimit === null || existing?.monthlyCostLimit === undefined ? null : String(existing.monthlyCostLimit) : nullableMoney(body.monthlyCostLimit),
    priceMultiplier: String(price)
  }
}

export async function listGroups(event: H3Event): Promise<HubGroupView[]> {
  const snapshot = await accessSnapshot(event)
  const userNames = new Map(snapshot.userRows.map(user => [user.id, user.displayName || user.username]))
  const usage = new Map(snapshot.groupUsageRows.map(item => [item.groupId, item]))
  return snapshot.groupRows.map(group => {
    const members = snapshot.membershipRows.filter(item => item.groupId === group.id)
    const userIds = members.map(item => item.userId)
    return {
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
      userIds,
      userNames: userIds.map(id => userNames.get(id)).filter((name): name is string => Boolean(name)),
      models: snapshot.modelRows.filter(item => item.groupId === group.id).map(item => item.publicModel),
      channelIds: snapshot.channelRows.filter(item => item.groupId === group.id && item.enabled).map(item => item.channelId),
      channelRules: snapshot.channelRows.filter(item => item.groupId === group.id).map(item => ({
        channelId: item.channelId,
        enabled: item.enabled,
        priorityOverride: item.priorityOverride,
        weightOverride: item.weightOverride
      })),
      keyCount: snapshot.keyRows.filter(key => key.groupId === group.id).length,
      usage: { requests: Number(usage.get(group.id)?.requests || 0), tokens: Number(usage.get(group.id)?.tokens || 0), cost: Number(usage.get(group.id)?.cost || 0) },
      createdAt: group.createdAt.getTime(),
      updatedAt: group.updatedAt.getTime()
    }
  })
}

export async function getGroup(event: H3Event, id: string) {
  const group = (await listGroups(event)).find(item => item.id === id)
  if (!group) throw createError({ statusCode: 404, message: '分组不存在' })
  return group
}

async function syncGroupRelations(event: H3Event, id: string, body: UnknownRecord, actorId: string) {
  let userIds = 'userIds' in body ? idArray(body.userIds) : null
  const channelRules = 'channelRules' in body
    ? channelRuleArray(body.channelRules)
    : 'channelIds' in body
      ? idArray(body.channelIds).map(channelId => ({ channelId, enabled: true, priorityOverride: null, weightOverride: null }))
      : null
  if (userIds) {
    if (userIds.length) {
      const rows = await useDatabase(event).select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, userIds))
      if (rows.length !== userIds.length) throw createError({ statusCode: 400, message: '包含不存在的用户' })
      if (id !== DEFAULT_GROUP_ID && rows.some(row => row.role === 'user')) {
        throw createError({ statusCode: 400, message: '普通用户固定归属默认分组，不能加入其他分组' })
      }
    }
    if (id === DEFAULT_GROUP_ID) {
      const ordinaryUsers = await useDatabase(event).select({ id: users.id }).from(users).where(eq(users.role, 'user'))
      userIds = [...new Set([...userIds, ...ordinaryUsers.map(user => user.id)])]
    }
    const assignedKeys = await useDatabase(event).select({ ownerUserId: hubKeys.ownerUserId }).from(hubKeys).where(eq(hubKeys.groupId, id))
    if (assignedKeys.some(key => key.ownerUserId && !userIds!.includes(key.ownerUserId))) {
      throw createError({ statusCode: 409, message: '待移除成员仍持有该分组的 Key，请先转移或删除相关 Key' })
    }
  }
  if (channelRules?.length) {
    const channelIds = channelRules.map(rule => rule.channelId)
    const rows = await useDatabase(event).select({ id: channels.id }).from(channels).where(inArray(channels.id, channelIds))
    if (rows.length !== channelIds.length) throw createError({ statusCode: 400, message: '渠道规则包含不存在的渠道' })
  }
  await withDatabaseTransaction(event, async () => {
    const db = useDatabase(event)
    if (userIds) {
      await db.delete(groupMemberships).where(eq(groupMemberships.groupId, id))
      if (userIds.length) await db.insert(groupMemberships).values(userIds.map(userId => ({ groupId: id, userId, createdBy: actorId })))
    }
    if ('models' in body) {
      const models = stringArray(body.models)
      await db.delete(groupModelRules).where(eq(groupModelRules.groupId, id))
      if (models.length) await db.insert(groupModelRules).values(models.map(publicModel => ({ groupId: id, publicModel })))
    }
    if (channelRules) {
      await db.delete(groupChannelRules).where(eq(groupChannelRules.groupId, id))
      if (channelRules.length) await db.insert(groupChannelRules).values(channelRules.map(rule => ({ groupId: id, ...rule })))
    }
  })
}

export async function createGroupRecord(event: H3Event, body: UnknownRecord, actorId: string) {
  const values = groupValues(body)
  if (!values.name) throw createError({ statusCode: 400, message: '请输入分组名称' })
  const [created] = await useDatabase(event).insert(groups).values(values).returning({ id: groups.id })
  if (!created) throw createError({ statusCode: 500, message: '创建分组失败' })
  await syncGroupRelations(event, created.id, body, actorId)
  return getGroup(event, created.id)
}

export async function updateGroupRecord(event: H3Event, id: string, body: UnknownRecord, actorId: string) {
  const current = await getGroup(event, id)
  await useDatabase(event).update(groups).set({ ...groupValues(body, current), updatedAt: new Date() }).where(eq(groups.id, id))
  await syncGroupRelations(event, id, body, actorId)
  return getGroup(event, id)
}

export async function deleteGroupRecord(event: H3Event, id: string) {
  if (id === DEFAULT_GROUP_ID) throw createError({ statusCode: 409, message: '默认分组不能删除' })
  const current = await getGroup(event, id)
  if (current.keyCount) throw createError({ statusCode: 409, message: '分组仍有 Hub Key，请先迁移 Key' })
  if (current.userIds.length) throw createError({ statusCode: 409, message: '分组仍有成员，请先将成员迁移到其他分组' })
  await useDatabase(event).delete(groups).where(eq(groups.id, id))
  await clearHubGroupState(event, id)
  return { success: true }
}
