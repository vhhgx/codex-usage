import { and, asc, count, desc, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { announcements, groupMemberships, groups, servicePlanVersions, servicePlans, usageRollups, userPoolGroups, userSubscriptions, users } from '../db/schema'
import { useDatabase } from '../db'
import { getHubSettings } from './hub-settings'
import { startOfZoned } from '../utils/time-zone'

export const DEFAULT_GROUP_ID = '00000000-0000-4000-8000-000000000001'
export const DEFAULT_PLAN_ID = '00000000-0000-4000-8000-000000000002'

type UnknownRecord = Record<string, unknown>

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export async function ensureDefaultGroup(event: H3Event, actorId?: string) {
  const [group] = await useDatabase(event).insert(groups).values({
    id: DEFAULT_GROUP_ID,
    name: '默认分组',
    description: '管理员统一配置的用户权限、渠道与模型范围'
  }).onConflictDoNothing().returning()
  return group || (await useDatabase(event).select().from(groups).where(eq(groups.id, DEFAULT_GROUP_ID)).limit(1))[0]!
}

export async function assignDefaultGroup(event: H3Event, userId: string, actorId?: string) {
  await ensureDefaultGroup(event, actorId)
  const db = useDatabase(event)
  await db.delete(groupMemberships).where(eq(groupMemberships.userId, userId))
  await db.insert(groupMemberships).values({ groupId: DEFAULT_GROUP_ID, userId, createdBy: actorId || null }).onConflictDoNothing()
}

export async function ensureDefaultPlan(event: H3Event, actorId?: string) {
  const db = useDatabase(event)
  await db.insert(servicePlans).values({
    id: DEFAULT_PLAN_ID,
    name: '默认不限量',
    description: '未单独分配套餐时使用，不限制 Token 或金额额度',
    mode: 'unlimited',
    cycle: 'none',
    status: 'active',
    createdBy: actorId || null
  }).onConflictDoNothing()
  const plan = (await db.select().from(servicePlans).where(eq(servicePlans.id, DEFAULT_PLAN_ID)).limit(1))[0]!
  await ensureCurrentPlanVersion(event, plan, actorId)
  return (await db.select().from(servicePlans).where(eq(servicePlans.id, DEFAULT_PLAN_ID)).limit(1))[0]!
}

function snapshotForPlan(plan: typeof servicePlans.$inferSelect, version?: typeof servicePlanVersions.$inferSelect) {
  return {
    planId: plan.id,
    planVersionId: version?.id || null,
    name: plan.name,
    description: plan.description,
    billingMode: version?.billingMode || (plan.mode === 'token' ? 'token_package' : plan.mode === 'cost' ? 'token_metered' : 'unlimited'),
    supplyMode: version?.supplyMode || 'platform_only',
    cycle: version?.cycle || plan.cycle,
    tokenLimit: version?.tokenLimit ?? plan.tokenLimit,
    quotaUnit: version?.quotaUnit || 'raw_token',
    price: version?.price || plan.price,
    maxPoolAccounts: version?.maxPoolAccounts ?? null,
    privateUsageBilling: version?.privateUsageBilling || 'free',
    privateUsageRateMultiplier: version?.privateUsageRateMultiplier || '1',
    allowedModels: version?.allowedModels || [],
    settings: version?.settings || {}
  }
}

async function ensureCurrentPlanVersion(event: H3Event, plan: typeof servicePlans.$inferSelect, actorId?: string) {
  const db = useDatabase(event)
  if (plan.currentVersionId) {
    const [current] = await db.select().from(servicePlanVersions).where(eq(servicePlanVersions.id, plan.currentVersionId)).limit(1)
    if (current) return current
  }
  const [latest] = await db.select().from(servicePlanVersions).where(eq(servicePlanVersions.planId, plan.id)).orderBy(sql`${servicePlanVersions.version} desc`).limit(1)
  if (latest) {
    await db.update(servicePlans).set({ currentVersionId: latest.id, updatedAt: new Date() }).where(eq(servicePlans.id, plan.id))
    return latest
  }
  const [created] = await db.insert(servicePlanVersions).values({
    planId: plan.id,
    version: 1,
    billingMode: plan.mode === 'token' ? 'token_package' : plan.mode === 'cost' ? 'token_metered' : 'unlimited',
    supplyMode: 'platform_only',
    cycle: plan.cycle,
    tokenLimit: plan.tokenLimit,
    quotaUnit: 'raw_token',
    price: plan.price,
    createdBy: actorId || plan.createdBy || null
  }).returning()
  if (created) await db.update(servicePlans).set({ currentVersionId: created.id, updatedAt: new Date() }).where(eq(servicePlans.id, plan.id))
  return created
}

export async function ensureDefaultSubscription(event: H3Event, userId: string, actorId?: string) {
  const plan = await ensureDefaultPlan(event, actorId)
  const version = await ensureCurrentPlanVersion(event, plan, actorId)
  await useDatabase(event).insert(userSubscriptions).values({
    userId,
    planId: DEFAULT_PLAN_ID,
    planVersionId: version?.id || null,
    entitlementSnapshot: snapshotForPlan(plan, version),
    assignedBy: actorId || null
  }).onConflictDoNothing()
}

function planValues(body: UnknownRecord, current?: typeof servicePlans.$inferSelect) {
  const requestedMode = String(body.mode || '')
  const billingMode = String(body.billingMode || '')
  const mode = ['unlimited', 'token', 'cost'].includes(requestedMode)
    ? requestedMode
    : billingMode === 'token_package' ? 'token' : billingMode === 'token_metered' ? 'cost' : current?.mode || 'unlimited'
  const cycle = ['none', 'week', 'month'].includes(String(body.cycle)) ? String(body.cycle) : current?.cycle || 'none'
  const tokenLimit = mode === 'token' ? nullableNumber(body.tokenLimit ?? current?.tokenLimit) : null
  const costLimit = mode === 'cost' ? nullableNumber(body.costLimit ?? current?.costLimit) : null
  if (mode === 'token' && (!tokenLimit || !Number.isInteger(tokenLimit))) throw createError({ statusCode: 400, message: 'Token 套餐必须填写正整数额度' })
  if (mode === 'cost' && !costLimit) throw createError({ statusCode: 400, message: '金额套餐必须填写大于 0 的额度' })
  return {
    name: body.name === undefined ? current?.name || '' : text(body.name, 120),
    description: body.description === undefined ? current?.description || null : text(body.description, 1000) || null,
    mode,
    cycle,
    tokenLimit: tokenLimit === null ? null : Math.round(tokenLimit),
    costLimit: costLimit === null ? null : String(costLimit),
    price: String(nullableNumber(body.price ?? current?.price) || 0),
    status: body.status === 'disabled' ? 'disabled' : body.status === 'active' ? 'active' : current?.status || 'active'
  }
}

function versionValues(body: UnknownRecord, plan: typeof servicePlans.$inferSelect, versionNumber: number, actorId: string | null) {
  const billingMode = ['unlimited', 'token_package', 'token_metered'].includes(String(body.billingMode))
    ? String(body.billingMode)
    : body.mode === 'token' ? 'token_package' : body.mode === 'cost' ? 'token_metered' : plan.mode === 'token' ? 'token_package' : plan.mode === 'cost' ? 'token_metered' : 'unlimited'
  const supplyMode = ['platform_only', 'platform_then_private', 'private_only'].includes(String(body.supplyMode)) ? String(body.supplyMode) : 'platform_only'
  const validCombination = billingMode === 'unlimited' ? supplyMode === 'platform_only' : billingMode === 'token_package' ? ['platform_only', 'platform_then_private', 'private_only'].includes(supplyMode) : ['platform_only', 'private_only'].includes(supplyMode)
  if (!validCombination) throw createError({ statusCode: 400, message: '计费方式与资源供给方式组合不受支持' })
  const quotaUnit = body.quotaUnit === 'weighted_token' ? 'weighted_token' : 'raw_token'
  const tokenLimit = body.tokenLimit === null || body.tokenLimit === undefined ? plan.tokenLimit : nullableNumber(body.tokenLimit)
  return {
    planId: plan.id,
    version: versionNumber,
    billingMode,
    supplyMode,
    cycle: ['none', 'week', 'month'].includes(String(body.cycle)) ? String(body.cycle) : plan.cycle,
    tokenLimit: tokenLimit === null ? null : Math.round(tokenLimit),
    quotaUnit,
    price: String(nullableNumber(body.price ?? plan.price) || 0),
    maxPoolAccounts: (() => { const value = nullableNumber(body.maxPoolAccounts); return value === null ? null : Math.floor(value) })(),
    privateUsageBilling: body.privateUsageBilling === 'metered' ? 'metered' : 'free',
    privateUsageRateMultiplier: String(nullableNumber(body.privateUsageRateMultiplier) || 1),
    allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels.filter((item): item is string => typeof item === 'string').slice(0, 200) : [],
    settings: body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings as Record<string, unknown> : {},
    createdBy: actorId
  }
}

export async function listPlans(event: H3Event) {
  const db = useDatabase(event)
  const [plans, counts, versions] = await Promise.all([
    db.select().from(servicePlans).orderBy(asc(servicePlans.name)),
    db.select({ planId: userSubscriptions.planId, value: count() }).from(userSubscriptions).groupBy(userSubscriptions.planId),
    db.select().from(servicePlanVersions).orderBy(asc(servicePlanVersions.planId), desc(servicePlanVersions.version))
  ])
  const countByPlan = new Map(counts.map(item => [item.planId, Number(item.value)]))
  const versionsByPlan = new Map<string, typeof versions>()
  for (const version of versions) versionsByPlan.set(version.planId, [...(versionsByPlan.get(version.planId) || []), version])
  return plans.map(plan => ({
    ...plan,
    tokenLimit: plan.tokenLimit,
    costLimit: plan.costLimit === null ? null : Number(plan.costLimit),
    price: Number(plan.price),
    subscriberCount: countByPlan.get(plan.id) || 0,
    currentVersion: versionsByPlan.get(plan.id)?.find(version => version.id === plan.currentVersionId) || versionsByPlan.get(plan.id)?.[0] || null,
    versions: (versionsByPlan.get(plan.id) || []).map(version => ({
      ...version,
      price: Number(version.price),
      privateUsageRateMultiplier: Number(version.privateUsageRateMultiplier),
      createdAt: version.createdAt.getTime()
    })),
    createdAt: plan.createdAt.getTime(),
    updatedAt: plan.updatedAt.getTime()
  }))
}

export async function createPlan(event: H3Event, body: UnknownRecord, actorId: string) {
  const values = planValues(body)
  if (!values.name) throw createError({ statusCode: 400, message: '请输入套餐名称' })
  const [created] = await useDatabase(event).insert(servicePlans).values({ ...values, createdBy: actorId }).returning()
  const [version] = await useDatabase(event).insert(servicePlanVersions).values(versionValues(body, created!, 1, actorId)).returning()
  await useDatabase(event).update(servicePlans).set({ currentVersionId: version!.id, updatedAt: new Date() }).where(eq(servicePlans.id, created!.id))
  return (await listPlans(event)).find(plan => plan.id === created!.id)!
}

export async function updatePlan(event: H3Event, id: string, body: UnknownRecord, actorId?: string) {
  const [current] = await useDatabase(event).select().from(servicePlans).where(eq(servicePlans.id, id)).limit(1)
  if (!current) throw createError({ statusCode: 404, message: '套餐不存在' })
  const values = planValues(body, current)
  if (!values.name) throw createError({ statusCode: 400, message: '请输入套餐名称' })
  const [latest] = await useDatabase(event).select({ version: sql<number>`coalesce(max(${servicePlanVersions.version}), 0)` }).from(servicePlanVersions).where(eq(servicePlanVersions.planId, id))
  const [version] = await useDatabase(event).insert(servicePlanVersions).values(versionValues(body, { ...current, ...values }, Number(latest?.version || 0) + 1, actorId || current.createdBy || null)).returning()
  await useDatabase(event).update(servicePlans).set({ name: values.name, description: values.description, status: values.status, mode: values.mode, cycle: values.cycle, tokenLimit: values.tokenLimit, costLimit: values.costLimit, price: values.price, currentVersionId: version!.id, updatedAt: new Date() }).where(eq(servicePlans.id, id))
  return (await listPlans(event)).find(plan => plan.id === id)!
}

export async function deletePlan(event: H3Event, id: string) {
  if (id === DEFAULT_PLAN_ID) throw createError({ statusCode: 409, message: '默认套餐不能删除' })
  const [assigned] = await useDatabase(event).select({ value: count() }).from(userSubscriptions).where(eq(userSubscriptions.planId, id))
  if (Number(assigned?.value)) throw createError({ statusCode: 409, message: '套餐仍有用户订阅，请先调整用户套餐' })
  await useDatabase(event).delete(servicePlans).where(eq(servicePlans.id, id))
  return { success: true }
}

function planExpiry(cycle: string, startsAt: Date) {
  if (cycle === 'week') return new Date(startsAt.getTime() + 7 * 86400_000)
  if (cycle === 'month') {
    const value = new Date(startsAt)
    value.setMonth(value.getMonth() + 1)
    return value
  }
  return null
}

export async function assignPlan(event: H3Event, userId: string, planId: string, startsAtRaw: unknown, actorId: string) {
  const db = useDatabase(event)
  const [[user], [plan]] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
    db.select().from(servicePlans).where(eq(servicePlans.id, planId)).limit(1)
  ])
  if (!user || !plan) throw createError({ statusCode: 400, message: '用户或套餐不存在' })
  if (plan.status !== 'active') throw createError({ statusCode: 409, message: '不能分配已停用套餐' })
  const startsAt = typeof startsAtRaw === 'string' && startsAtRaw ? new Date(startsAtRaw) : new Date()
  if (Number.isNaN(startsAt.getTime())) throw createError({ statusCode: 400, message: '套餐开始时间不正确' })
  const expiresAt = planExpiry(plan.cycle, startsAt)
  const version = await ensureCurrentPlanVersion(event, plan, actorId)
  const entitlementSnapshot = snapshotForPlan(plan, version)
  await db.insert(userSubscriptions).values({ userId, planId, planVersionId: version?.id || null, entitlementSnapshot, startsAt, expiresAt, assignedBy: actorId, status: 'active' }).onConflictDoUpdate({
    target: userSubscriptions.userId,
    set: { planId, planVersionId: version?.id || null, entitlementSnapshot, startsAt, expiresAt, assignedBy: actorId, status: 'active', updatedAt: new Date() }
  })
  await db.update(userPoolGroups).set({ maxAccounts: entitlementSnapshot.maxPoolAccounts, updatedAt: new Date() }).where(eq(userPoolGroups.ownerUserId, userId))
  return getUserPlan(event, userId)
}

export async function getUserPlan(event: H3Event, userId: string) {
  await ensureDefaultSubscription(event, userId)
  const db = useDatabase(event)
  const [row] = await db.select({ subscription: userSubscriptions, plan: servicePlans }).from(userSubscriptions)
    .innerJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id)).where(eq(userSubscriptions.userId, userId)).limit(1)
  if (!row) return null
  const version = row.subscription.planVersionId
    ? (await db.select().from(servicePlanVersions).where(eq(servicePlanVersions.id, row.subscription.planVersionId)).limit(1))[0]
    : await ensureCurrentPlanVersion(event, row.plan)
  const snapshot = Object.keys(row.subscription.entitlementSnapshot || {}).length
    ? row.subscription.entitlementSnapshot
    : snapshotForPlan(row.plan, version)
  if (!Object.keys(row.subscription.entitlementSnapshot || {}).length || row.subscription.planVersionId !== version?.id) {
    await db.update(userSubscriptions).set({ planVersionId: version?.id || null, entitlementSnapshot: snapshot, updatedAt: new Date() }).where(eq(userSubscriptions.id, row.subscription.id))
  }
  const settings = await getHubSettings(event)
  const today = startOfZoned(new Date(), 'day', settings.timezone)
  const [usage] = await db.select({
    tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)`,
    cost: sql<string>`coalesce(sum(${usageRollups.cost}), 0)`,
    requests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}), 0)`,
    todayTokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}) filter (where ${usageRollups.bucketStart} >= ${today.toISOString()}::timestamptz), 0)`,
    todayCost: sql<string>`coalesce(sum(${usageRollups.cost}) filter (where ${usageRollups.bucketStart} >= ${today.toISOString()}::timestamptz), 0)`,
    todayRequests: sql<number>`coalesce(sum(${usageRollups.admittedRequests}) filter (where ${usageRollups.bucketStart} >= ${today.toISOString()}::timestamptz), 0)`
  }).from(usageRollups).where(and(
    eq(usageRollups.userId, userId),
    eq(usageRollups.granularity, 'day'),
    eq(usageRollups.supplySource, 'platform'),
    gte(usageRollups.bucketStart, row.subscription.startsAt)
  ))
  const expired = row.subscription.expiresAt !== null && row.subscription.expiresAt <= new Date()
  return {
    id: row.subscription.id,
    status: expired ? 'expired' : row.subscription.status,
    startsAt: row.subscription.startsAt.getTime(),
    expiresAt: row.subscription.expiresAt?.getTime() || null,
    plan: {
      id: row.plan.id,
      name: row.plan.name,
      description: row.plan.description,
      mode: row.plan.mode,
      cycle: row.plan.cycle,
      tokenLimit: row.plan.tokenLimit,
      costLimit: row.plan.costLimit === null ? null : Number(row.plan.costLimit),
      price: Number(row.plan.price),
      version: version ? { ...version, price: Number(version.price), privateUsageRateMultiplier: Number(version.privateUsageRateMultiplier) } : null,
      entitlementSnapshot: snapshot
    },
    usage: {
      requests: Number(usage?.requests || 0),
      tokens: Number(usage?.tokens || 0),
      cost: Number(usage?.cost || 0),
      today: {
        requests: Number(usage?.todayRequests || 0),
        tokens: Number(usage?.todayTokens || 0),
        cost: Number(usage?.todayCost || 0)
      }
    }
  }
}

export async function getActiveSubscription(event: H3Event, userId: string) {
  await ensureDefaultSubscription(event, userId)
  const now = new Date()
  return (await useDatabase(event).select({ subscription: userSubscriptions, plan: servicePlans }).from(userSubscriptions)
    .innerJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id))
    .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 'active'), lte(userSubscriptions.startsAt, now), or(isNull(userSubscriptions.expiresAt), gt(userSubscriptions.expiresAt, now))))
    .limit(1))[0] || null
}

export async function requireActiveSubscription(event: H3Event, userId: string) {
  await ensureDefaultSubscription(event, userId)
  const [row] = await useDatabase(event).select({ subscription: userSubscriptions, plan: servicePlans }).from(userSubscriptions)
    .innerJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id))
    .where(eq(userSubscriptions.userId, userId)).limit(1)
  if (!row) throw createError({ statusCode: 429, message: '当前账号没有可用套餐，请联系管理员' })
  const now = new Date()
  if (row.subscription.status !== 'active' || row.plan.status !== 'active') {
    throw createError({ statusCode: 429, message: '当前套餐已停用，请联系管理员' })
  }
  if (row.subscription.startsAt > now) {
    throw createError({ statusCode: 429, message: '当前套餐尚未生效' })
  }
  if (row.subscription.expiresAt && row.subscription.expiresAt <= now) {
    throw createError({ statusCode: 429, message: '当前套餐已到期，请联系管理员续期' })
  }
  return row
}

export async function listPlanAssignments(event: H3Event) {
  const db = useDatabase(event)
  const rows = await db.select({ user: users, subscription: userSubscriptions, plan: servicePlans }).from(users)
    .leftJoin(userSubscriptions, eq(users.id, userSubscriptions.userId))
    .leftJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id))
    .where(eq(users.role, 'user')).orderBy(asc(users.username))
  return rows.map(({ user, subscription, plan }) => ({
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    subscription: subscription && plan ? {
      id: subscription.id,
      planId: plan.id,
      planName: plan.name,
      startsAt: subscription.startsAt.getTime(),
      expiresAt: subscription.expiresAt?.getTime() || null,
      status: subscription.expiresAt && subscription.expiresAt <= new Date() ? 'expired' : subscription.status
    } : null
  }))
}

function announcementValues(body: UnknownRecord, current?: typeof announcements.$inferSelect) {
  const expiresAt = body.expiresAt === undefined ? current?.expiresAt || null : typeof body.expiresAt === 'string' && body.expiresAt ? new Date(body.expiresAt) : null
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw createError({ statusCode: 400, message: '公告到期时间不正确' })
  const status = body.status === 'published' ? 'published' : body.status === 'draft' ? 'draft' : current?.status || 'draft'
  return {
    title: body.title === undefined ? current?.title || '' : text(body.title, 160),
    content: body.content === undefined ? current?.content || '' : text(body.content, 5000),
    tone: body.tone === 'warning' ? 'warning' : body.tone === 'success' ? 'success' : 'info',
    status,
    publishedAt: status === 'published' ? current?.publishedAt || new Date() : null,
    expiresAt
  }
}

export async function listAnnouncements(event: H3Event, publishedOnly = false) {
  const now = new Date()
  const rows = await useDatabase(event).select().from(announcements).where(publishedOnly
    ? and(eq(announcements.status, 'published'), lte(announcements.publishedAt, now), or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)))
    : undefined).orderBy(desc(announcements.publishedAt), desc(announcements.createdAt))
  return rows.map(item => ({ ...item, publishedAt: item.publishedAt?.getTime() || null, expiresAt: item.expiresAt?.getTime() || null, createdAt: item.createdAt.getTime(), updatedAt: item.updatedAt.getTime() }))
}

export async function createAnnouncement(event: H3Event, body: UnknownRecord, actorId: string) {
  const values = announcementValues(body)
  if (!values.title || !values.content) throw createError({ statusCode: 400, message: '公告标题和内容不能为空' })
  const [created] = await useDatabase(event).insert(announcements).values({ ...values, createdBy: actorId }).returning({ id: announcements.id })
  return (await listAnnouncements(event)).find(item => item.id === created!.id)!
}

export async function updateAnnouncement(event: H3Event, id: string, body: UnknownRecord) {
  const [current] = await useDatabase(event).select().from(announcements).where(eq(announcements.id, id)).limit(1)
  if (!current) throw createError({ statusCode: 404, message: '公告不存在' })
  const values = announcementValues(body, current)
  if (!values.title || !values.content) throw createError({ statusCode: 400, message: '公告标题和内容不能为空' })
  await useDatabase(event).update(announcements).set({ ...values, updatedAt: new Date() }).where(eq(announcements.id, id))
  return (await listAnnouncements(event)).find(item => item.id === id)!
}

export async function deleteAnnouncement(event: H3Event, id: string) {
  await useDatabase(event).delete(announcements).where(eq(announcements.id, id))
  return { success: true }
}
