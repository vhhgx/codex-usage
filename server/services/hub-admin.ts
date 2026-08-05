import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { ChannelModelView, ChannelView, HubKeyCredentialView, HubKeyView } from '#shared/types/hub'
import { supportsImagePricing } from '#shared/utils/model-capabilities'
import { useDatabase } from '../db'
import { channelModels, channels, groupMemberships, groups, hubKeyCredentials, hubKeys, keyModelRules, modelPools, modelPrices, users } from '../db/schema'
import { createHubKey, decryptHubKeySecret, decryptSecret, encryptHubKeySecret, encryptSecret, hashHubKey, validateHubKeySecret } from '../utils/hub-crypto'
import { getHubSettings } from './hub-settings'
import { channelCircuitState } from './hub-routing'
import { discoverUpstreamModelIds, mergeDiscoveredModelMappings } from './hub-model-discovery'

type UnknownRecord = Record<string, unknown>

function text(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function nullableInteger(value: unknown, min = 0) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : null
}

function nullableMoney(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : null
}

function nonnegativeNumber(value: unknown, fallback: number) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw createError({ statusCode: 400, message: '价格倍率必须是非负数' })
  return parsed
}

function stringArray(value: unknown, maxItems = 100) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => text(item, 200)).filter(Boolean))].slice(0, maxItems)
}

function moneyMap(value: unknown, maxItems = 50) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as UnknownRecord).flatMap(([rawKey, rawValue]) => {
    const key = text(rawKey, 100)
    const amount = Number(rawValue)
    return key && Number.isFinite(amount) && amount >= 0 ? [[key, amount]] : []
  }).slice(0, maxItems))
}

function dateValue(value: unknown) {
  if (!value) return null
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw createError({ statusCode: 400, message: '到期时间格式不正确' })
  return parsed
}

function expiryValue(body: UnknownRecord, createdAt: Date) {
  if ('expiresInDays' in body && body.expiresInDays !== null && body.expiresInDays !== '') {
    const days = Number(body.expiresInDays)
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw createError({ statusCode: 400, message: '创建后到期天数必须是 1 到 3650 的整数' })
    }
    return new Date(createdAt.getTime() + days * 86400_000)
  }
  return dateValue(body.expiresAt)
}

function channelView(row: typeof channels.$inferSelect, models: ChannelModelView[], circuitState: ChannelView['circuitState']): ChannelView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    priority: row.priority,
    weight: row.weight,
    maxConcurrency: row.maxConcurrency,
    timeoutMs: row.timeoutMs,
    priceMultiplier: Number(row.priceMultiplier),
    healthStatus: row.healthStatus,
    circuitState,
    lastHealthCheckAt: row.lastHealthCheckAt?.getTime() || null,
    lastHealthError: row.lastHealthError,
    models,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

export async function listChannels(event: H3Event) {
  const db = useDatabase(event)
  const rows = await db.select().from(channels).orderBy(asc(channels.priority), asc(channels.name))
  const modelRows = rows.length
    ? await db.select().from(channelModels).where(inArray(channelModels.channelId, rows.map(row => row.id)))
    : []
  return Promise.all(rows.map(async row => channelView(
    row,
    modelRows.filter(model => model.channelId === row.id).map(model => ({
      id: model.id,
      publicModel: model.publicModel,
      upstreamModel: model.upstreamModel,
      enabled: model.enabled,
      endpoints: model.endpoints
    })),
    await channelCircuitState(event, row.id)
  )))
}

function parseModels(value: unknown): ChannelModelView[] {
  if (!Array.isArray(value)) return []
  const parsed = value.flatMap((raw) => {
    const item = raw && typeof raw === 'object' ? raw as UnknownRecord : null
    const publicModel = text(item?.publicModel, 200)
    const upstreamModel = text(item?.upstreamModel, 200)
    if (!publicModel || !upstreamModel) return []
    return [{
      publicModel,
      upstreamModel,
      enabled: item?.enabled !== false,
      endpoints: stringArray(item?.endpoints, 10)
    }]
  })
  return [...new Map(parsed.map(model => [model.publicModel, model])).values()]
}

export async function createChannelRecord(event: H3Event, body: UnknownRecord) {
  const name = text(body.name, 120)
  const baseUrl = text(body.baseUrl, 1000).replace(/\/+$/, '')
  const apiKey = text(body.apiKey, 2000)
  const type = body.type === 'sub2api' ? 'sub2api' : body.type === 'cpa' ? 'cpa' : null
  if (!name || !baseUrl || !apiKey || !type) throw createError({ statusCode: 400, message: '渠道名称、类型、地址和 API Key 均为必填项' })
  try { new URL(baseUrl) } catch { throw createError({ statusCode: 400, message: '渠道地址格式不正确' }) }
  let models = parseModels(body.models)
  if (type === 'sub2api') {
    try {
      const discovered = await discoverUpstreamModelIds(baseUrl, apiKey, integer(body.timeoutMs, 1000, 600000, 15000))
      models = mergeDiscoveredModelMappings(discovered, models)
    } catch (error) {
      if (!models.length) throw error
    }
  }
  const db = useDatabase(event)
  const defaultTimeoutMs = (await getHubSettings(event)).defaultTimeoutMs
  const [row] = await db.insert(channels).values({
    name,
    type,
    baseUrl,
    encryptedApiKey: encryptSecret(apiKey, event),
    enabled: body.enabled !== false,
    priority: integer(body.priority, 0, 10000, 100),
    weight: integer(body.weight, 1, 1000, 1),
    maxConcurrency: integer(body.maxConcurrency, 1, 10000, 20),
    timeoutMs: integer(body.timeoutMs, 1000, 600000, defaultTimeoutMs),
    priceMultiplier: String(nonnegativeNumber(body.priceMultiplier, 1))
  }).returning()
  if (!row) throw createError({ statusCode: 500, message: '创建渠道失败' })
  if (models.length) {
    await db.insert(channelModels).values(models.map(model => ({ ...model, channelId: row.id })))
    for (const model of models) {
      await db.insert(modelPools).values({ publicModel: model.publicModel }).onConflictDoNothing()
    }
  }
  return (await listChannels(event)).find(item => item.id === row.id)!
}

export async function updateChannelRecord(event: H3Event, id: string, body: UnknownRecord) {
  const db = useDatabase(event)
  const [existing] = await db.select().from(channels).where(eq(channels.id, id)).limit(1)
  if (!existing) throw createError({ statusCode: 404, message: '渠道不存在' })
  const patch: Partial<typeof channels.$inferInsert> = { updatedAt: new Date() }
  if ('name' in body) patch.name = text(body.name, 120) || existing.name
  if ('baseUrl' in body) {
    const baseUrl = text(body.baseUrl, 1000).replace(/\/+$/, '')
    try { new URL(baseUrl) } catch { throw createError({ statusCode: 400, message: '渠道地址格式不正确' }) }
    patch.baseUrl = baseUrl
  }
  if (text(body.apiKey, 2000)) patch.encryptedApiKey = encryptSecret(text(body.apiKey, 2000), event)
  if ('enabled' in body) patch.enabled = body.enabled === true
  if ('priority' in body) patch.priority = integer(body.priority, 0, 10000, existing.priority)
  if ('weight' in body) patch.weight = integer(body.weight, 1, 1000, existing.weight)
  if ('maxConcurrency' in body) patch.maxConcurrency = integer(body.maxConcurrency, 1, 10000, existing.maxConcurrency)
  if ('timeoutMs' in body) patch.timeoutMs = integer(body.timeoutMs, 1000, 600000, existing.timeoutMs)
  if ('priceMultiplier' in body) patch.priceMultiplier = String(nonnegativeNumber(body.priceMultiplier, Number(existing.priceMultiplier)))
  await db.update(channels).set(patch).where(eq(channels.id, id))
  if ('models' in body) {
    let models = parseModels(body.models)
    if (existing.type === 'sub2api' && !models.length) {
      const apiKey = text(body.apiKey, 2000) || decryptSecret(existing.encryptedApiKey, event)
      const discovered = await discoverUpstreamModelIds(
        String(patch.baseUrl || existing.baseUrl),
        apiKey,
        Number(patch.timeoutMs || existing.timeoutMs)
      )
      models = discovered.map(publicModel => ({ publicModel, upstreamModel: publicModel, enabled: true, endpoints: [] }))
    }
    await db.delete(channelModels).where(eq(channelModels.channelId, id))
    if (models.length) await db.insert(channelModels).values(models.map(model => ({ ...model, channelId: id })))
    for (const model of models) await db.insert(modelPools).values({ publicModel: model.publicModel }).onConflictDoNothing()
  }
  return (await listChannels(event)).find(item => item.id === id)!
}

function keyView(row: typeof hubKeys.$inferSelect, models: string[], ownerUserName: string | null = null, groupName: string | null = null): HubKeyView {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    maskedKey: `${row.keyPrefix}...${row.keyLastFour}`,
    revealable: Boolean(row.encryptedKey),
    ownerUserId: row.ownerUserId,
    ownerUserName,
    groupId: row.groupId,
    groupName,
    status: row.expiresAt && row.expiresAt <= new Date() && row.status === 'active' ? 'expired' : row.status,
    expiresAt: row.expiresAt?.getTime() || null,
    allowedEndpoints: row.allowedEndpoints,
    allowedModels: models,
    rpmLimit: row.rpmLimit,
    concurrencyLimit: row.concurrencyLimit,
    totalRequestLimit: row.totalRequestLimit,
    totalTokenLimit: row.totalTokenLimit,
    totalCostLimit: row.totalCostLimit === null ? null : Number(row.totalCostLimit),
    dailyRequestLimit: row.dailyRequestLimit,
    dailyTokenLimit: row.dailyTokenLimit,
    dailyCostLimit: row.dailyCostLimit === null ? null : Number(row.dailyCostLimit),
    weeklyRequestLimit: row.weeklyRequestLimit,
    weeklyTokenLimit: row.weeklyTokenLimit,
    weeklyCostLimit: row.weeklyCostLimit === null ? null : Number(row.weeklyCostLimit),
    monthlyRequestLimit: row.monthlyRequestLimit,
    monthlyTokenLimit: row.monthlyTokenLimit,
    monthlyCostLimit: row.monthlyCostLimit === null ? null : Number(row.monthlyCostLimit),
    maxRequestTokens: row.maxRequestTokens,
    maxRequestCost: row.maxRequestCost === null ? null : Number(row.maxRequestCost),
    maxImageCount: row.maxImageCount,
    allowedImageSizes: row.allowedImageSizes,
    allowedImageQualities: row.allowedImageQualities,
    priceMultiplier: Number(row.priceMultiplier),
    lastUsedAt: row.lastUsedAt?.getTime() || null,
    createdAt: row.createdAt.getTime()
  }
}

export async function listHubKeys(event: H3Event) {
  const db = useDatabase(event)
  const rows = await db.select().from(hubKeys).orderBy(desc(hubKeys.createdAt))
  const [rules, userRows, groupRows] = await Promise.all([
    rows.length ? db.select().from(keyModelRules).where(inArray(keyModelRules.keyId, rows.map(row => row.id))) : [],
    db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users),
    db.select({ id: groups.id, name: groups.name }).from(groups)
  ])
  const userNames = new Map(userRows.map(user => [user.id, user.displayName || user.username]))
  const groupNames = new Map(groupRows.map(group => [group.id, group.name]))
  return rows.map(row => keyView(
    row,
    rules.filter(rule => rule.keyId === row.id).map(rule => rule.publicModel),
    row.ownerUserId ? userNames.get(row.ownerUserId) || null : null,
    row.groupId ? groupNames.get(row.groupId) || null : null
  ))
}

function keyValues(body: UnknownRecord, createdAt = new Date()) {
  return {
    name: text(body.name, 120),
    note: text(body.note, 1000) || null,
    expiresAt: expiryValue(body, createdAt),
    allowedEndpoints: stringArray(body.allowedEndpoints, 20),
    rpmLimit: nullableInteger(body.rpmLimit, 1),
    concurrencyLimit: nullableInteger(body.concurrencyLimit, 1),
    totalRequestLimit: nullableInteger(body.totalRequestLimit, 1),
    totalTokenLimit: nullableInteger(body.totalTokenLimit, 1),
    totalCostLimit: nullableMoney(body.totalCostLimit),
    dailyRequestLimit: nullableInteger(body.dailyRequestLimit, 1),
    dailyTokenLimit: nullableInteger(body.dailyTokenLimit, 1),
    dailyCostLimit: nullableMoney(body.dailyCostLimit),
    weeklyRequestLimit: nullableInteger(body.weeklyRequestLimit, 1),
    weeklyTokenLimit: nullableInteger(body.weeklyTokenLimit, 1),
    weeklyCostLimit: nullableMoney(body.weeklyCostLimit),
    monthlyRequestLimit: nullableInteger(body.monthlyRequestLimit, 1),
    monthlyTokenLimit: nullableInteger(body.monthlyTokenLimit, 1),
    monthlyCostLimit: nullableMoney(body.monthlyCostLimit),
    maxRequestTokens: nullableInteger(body.maxRequestTokens, 1),
    maxRequestCost: nullableMoney(body.maxRequestCost),
    maxImageCount: nullableInteger(body.maxImageCount, 1),
    allowedImageSizes: stringArray(body.allowedImageSizes, 20),
    allowedImageQualities: stringArray(body.allowedImageQualities, 20),
    priceMultiplier: String(nonnegativeNumber(body.priceMultiplier, 1))
  }
}

async function resolveKeyOwnership(event: H3Event, ownerUserIdRaw: unknown, groupIdRaw: unknown, actorId?: string) {
  const db = useDatabase(event)
  const ownerUserId = text(ownerUserIdRaw, 100) || actorId || ''
  const [owner] = ownerUserId ? await db.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1) : []
  if (!owner) throw createError({ statusCode: 400, message: '请选择有效的 Key 所属用户' })
  let groupId = text(groupIdRaw, 100)
  if (!groupId) {
    const [membership] = await db.select({ groupId: groupMemberships.groupId }).from(groupMemberships).where(eq(groupMemberships.userId, ownerUserId)).limit(1)
    groupId = membership?.groupId || ''
  }
  const [membership] = groupId ? await db.select({ id: groupMemberships.id }).from(groupMemberships)
    .where(and(eq(groupMemberships.userId, ownerUserId), eq(groupMemberships.groupId, groupId))).limit(1) : []
  if (!membership) throw createError({ statusCode: 400, message: 'Key 所属用户必须是所选分组成员' })
  return { ownerUserId, groupId }
}

export async function createHubKeyRecord(event: H3Event, body: UnknownRecord, actorId?: string) {
  const values = keyValues(body)
  if (!values.name) throw createError({ statusCode: 400, message: '请输入 Key 名称' })
  if (values.expiresAt && values.expiresAt <= new Date()) throw createError({ statusCode: 400, message: '到期时间必须晚于当前时间' })
  const plainKey = typeof body.key === 'string' && body.key ? validateHubKeySecret(body.key) : createHubKey()
  const ownership = await resolveKeyOwnership(event, body.ownerUserId, body.groupId, actorId)
  const keyId = randomUUID()
  const credentialId = randomUUID()
  const encrypted = encryptHubKeySecret(plainKey, keyId, credentialId, event)
  const db = useDatabase(event)
  const models = stringArray(body.allowedModels, 200)
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(hubKeys).values({
      id: keyId,
      ...values,
      keyHash: hashHubKey(plainKey, event),
      keyPrefix: plainKey.slice(0, 10),
      keyLastFour: plainKey.slice(-4),
      encryptedKey: encrypted.encrypted,
      encryptionKeyVersion: encrypted.version,
      ownerUserId: ownership.ownerUserId,
      groupId: ownership.groupId,
      secretUpdatedAt: new Date(),
      secretUpdatedBy: actorId || ownership.ownerUserId,
      status: 'active'
    }).returning()
    if (!created) throw createError({ statusCode: 500, message: '创建 Hub Key 失败' })
    await tx.insert(hubKeyCredentials).values({
      id: credentialId,
      keyId: created.id,
      keyHash: created.keyHash,
      keyPrefix: created.keyPrefix,
      keyLastFour: created.keyLastFour,
      encryptedKey: encrypted.encrypted,
      encryptionKeyVersion: encrypted.version,
      createdBy: actorId || ownership.ownerUserId
    })
    if (models.length) await tx.insert(keyModelRules).values(models.map(publicModel => ({ keyId: created.id, publicModel })))
    return created
  })
  return { key: plainKey, item: (await listHubKeys(event)).find(item => item.id === row.id)! }
}

function credentialView(row: typeof hubKeyCredentials.$inferSelect, currentHash: string): HubKeyCredentialView {
  const expired = row.expiresAt !== null && row.expiresAt <= new Date()
  return {
    id: row.id,
    maskedKey: `${row.keyPrefix}...${row.keyLastFour}`,
    status: row.status === 'revoked' ? 'revoked' : expired || row.status === 'expired' ? 'expired' : 'active',
    expiresAt: row.expiresAt?.getTime() || null,
    lastUsedAt: row.lastUsedAt?.getTime() || null,
    createdAt: row.createdAt.getTime(),
    current: row.keyHash === currentHash,
    revealable: Boolean(row.encryptedKey)
  }
}

export async function listHubKeyCredentials(event: H3Event, id: string) {
  const db = useDatabase(event)
  const [key] = await db.select().from(hubKeys).where(eq(hubKeys.id, id)).limit(1)
  if (!key) throw createError({ statusCode: 404, message: 'Hub Key 不存在' })
  const rows = await db.select().from(hubKeyCredentials).where(eq(hubKeyCredentials.keyId, id)).orderBy(desc(hubKeyCredentials.createdAt))
  return rows.map(row => credentialView(row, key.keyHash))
}

async function activateHubKeySecret(event: H3Event, id: string, plainKey: string, graceSeconds: number, actorId?: string) {
  const db = useDatabase(event)
  const [key] = await db.select().from(hubKeys).where(eq(hubKeys.id, id)).limit(1)
  if (!key) throw createError({ statusCode: 404, message: 'Hub Key 不存在' })
  validateHubKeySecret(plainKey)
  const grace = Math.min(7 * 86400, Math.max(0, Number.isInteger(graceSeconds) ? graceSeconds : 3600))
  const now = new Date()
  const credentialId = randomUUID()
  const encrypted = encryptHubKeySecret(plainKey, id, credentialId, event)
  if (grace > 0) {
    await db.update(hubKeyCredentials).set({ expiresAt: new Date(now.getTime() + grace * 1000), updatedAt: now })
      .where(and(eq(hubKeyCredentials.keyId, id), eq(hubKeyCredentials.keyHash, key.keyHash), eq(hubKeyCredentials.status, 'active')))
  } else {
    await db.update(hubKeyCredentials).set({ status: 'revoked', revokedAt: now, updatedAt: now })
      .where(and(eq(hubKeyCredentials.keyId, id), eq(hubKeyCredentials.status, 'active')))
  }
  const [credential] = await db.insert(hubKeyCredentials).values({
    id: credentialId,
    keyId: id,
    keyHash: hashHubKey(plainKey, event),
    keyPrefix: plainKey.slice(0, 10),
    keyLastFour: plainKey.slice(-4),
    encryptedKey: encrypted.encrypted,
    encryptionKeyVersion: encrypted.version,
    createdBy: actorId || key.ownerUserId
  }).returning()
  await db.update(hubKeys).set({
    keyHash: credential!.keyHash,
    keyPrefix: credential!.keyPrefix,
    keyLastFour: credential!.keyLastFour,
    encryptedKey: encrypted.encrypted,
    encryptionKeyVersion: encrypted.version,
    secretUpdatedAt: now,
    secretUpdatedBy: actorId || key.ownerUserId,
    updatedAt: now
  }).where(eq(hubKeys.id, id))
  return { key: plainKey, credential: credentialView(credential!, credential!.keyHash), graceSeconds: grace }
}

export function rotateHubKeyCredential(event: H3Event, id: string, graceSeconds: number, actorId?: string) {
  return activateHubKeySecret(event, id, createHubKey(), graceSeconds, actorId)
}

export function replaceHubKeySecret(event: H3Event, id: string, plainKey: string, graceSeconds: number, actorId: string) {
  return activateHubKeySecret(event, id, plainKey, graceSeconds, actorId)
}

export async function revealHubKeySecret(event: H3Event, id: string) {
  const db = useDatabase(event)
  const [key] = await db.select().from(hubKeys).where(eq(hubKeys.id, id)).limit(1)
  if (!key) throw createError({ statusCode: 404, message: 'Hub Key 不存在' })
  const [credential] = await db.select().from(hubKeyCredentials).where(and(
    eq(hubKeyCredentials.keyId, id),
    eq(hubKeyCredentials.keyHash, key.keyHash)
  )).limit(1)
  if (!credential?.encryptedKey) throw createError({ statusCode: 409, message: '旧 Key 没有可回显密文，请由管理员设置新的 Key 值' })
  try {
    return { key: decryptHubKeySecret(credential.encryptedKey, id, credential.id, event), maskedKey: `${credential.keyPrefix}...${credential.keyLastFour}` }
  } catch {
    throw createError({ statusCode: 500, message: 'Key 密文无法解密，请检查密钥版本配置' })
  }
}

export async function revokeHubKeyCredential(event: H3Event, keyId: string, credentialId: string) {
  const db = useDatabase(event)
  const [key] = await db.select().from(hubKeys).where(eq(hubKeys.id, keyId)).limit(1)
  const [credential] = await db.select().from(hubKeyCredentials).where(and(eq(hubKeyCredentials.id, credentialId), eq(hubKeyCredentials.keyId, keyId))).limit(1)
  if (!key || !credential) throw createError({ statusCode: 404, message: 'Key 凭据不存在' })
  if (credential.keyHash === key.keyHash) throw createError({ statusCode: 409, message: '当前凭据不能直接吊销，请先轮换 Key' })
  await db.update(hubKeyCredentials).set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() }).where(eq(hubKeyCredentials.id, credentialId))
  return { success: true }
}

export async function updateHubKeyRecord(event: H3Event, id: string, body: UnknownRecord) {
  const db = useDatabase(event)
  const [existing] = await db.select().from(hubKeys).where(eq(hubKeys.id, id)).limit(1)
  if (!existing) throw createError({ statusCode: 404, message: 'Hub Key 不存在' })
  const values = keyValues({
    ...Object.fromEntries(Object.entries(existing).filter(([, value]) => value !== undefined)),
    ...body
  }, existing.createdAt)
  const status = body.status === 'disabled' ? 'disabled' : body.status === 'active' ? 'active' : existing.status
  const ownership = 'ownerUserId' in body || 'groupId' in body
    ? await resolveKeyOwnership(event, body.ownerUserId ?? existing.ownerUserId, body.groupId ?? existing.groupId)
    : { ownerUserId: existing.ownerUserId, groupId: existing.groupId }
  await db.transaction(async (tx) => {
    await tx.update(hubKeys).set({ ...values, ...ownership, status, updatedAt: new Date() }).where(eq(hubKeys.id, id))
    if ('allowedModels' in body) {
      const models = stringArray(body.allowedModels, 200)
      await tx.delete(keyModelRules).where(eq(keyModelRules.keyId, id))
      if (models.length) await tx.insert(keyModelRules).values(models.map(publicModel => ({ keyId: id, publicModel })))
    }
  })
  return (await listHubKeys(event)).find(item => item.id === id)!
}

export async function listModelConfiguration(event: H3Event) {
  const db = useDatabase(event)
  const [pools, prices, mappings] = await Promise.all([
    db.select().from(modelPools).orderBy(asc(modelPools.publicModel)),
    db.select().from(modelPrices).orderBy(desc(modelPrices.effectiveAt)),
    db.select({ publicModel: channelModels.publicModel, endpoints: channelModels.endpoints }).from(channelModels).where(eq(channelModels.enabled, true))
  ])
  const endpointsByModel = new Map<string, Set<string>>()
  const endpointGroupsByModel = new Map<string, string[][]>()
  for (const mapping of mappings) {
    if (!endpointsByModel.has(mapping.publicModel)) endpointsByModel.set(mapping.publicModel, new Set())
    if (!endpointGroupsByModel.has(mapping.publicModel)) endpointGroupsByModel.set(mapping.publicModel, [])
    mapping.endpoints.forEach(endpoint => endpointsByModel.get(mapping.publicModel)!.add(endpoint))
    endpointGroupsByModel.get(mapping.publicModel)!.push(mapping.endpoints)
  }
  return pools.map(pool => ({
    id: pool.id,
    publicModel: pool.publicModel,
    strategy: pool.strategy,
    enabled: pool.enabled,
    endpoints: [...(endpointsByModel.get(pool.publicModel) || [])].sort(),
    imageCapable: supportsImagePricing(pool.publicModel, endpointGroupsByModel.get(pool.publicModel) || []),
    price: prices.find(price => price.publicModel === pool.publicModel) || null
  }))
}

export async function updateModelConfiguration(event: H3Event, publicModel: string, body: UnknownRecord) {
  const db = useDatabase(event)
  const strategy = body.strategy === 'weighted_round_robin' ? 'weighted_round_robin' : 'priority'
  await db.insert(modelPools).values({ publicModel, strategy, enabled: body.enabled !== false }).onConflictDoUpdate({
    target: modelPools.publicModel,
    set: { strategy, enabled: body.enabled !== false, updatedAt: new Date() }
  })
  if (body.price && typeof body.price === 'object') {
    const price = body.price as UnknownRecord
    await db.insert(modelPrices).values({
      publicModel,
      inputPerMillion: String(Math.max(0, Number(price.inputPerMillion) || 0)),
      outputPerMillion: String(Math.max(0, Number(price.outputPerMillion) || 0)),
      cachedPerMillion: String(Math.max(0, Number(price.cachedPerMillion) || 0)),
      reasoningPerMillion: String(Math.max(0, Number(price.reasoningPerMillion) || 0)),
      imagePrices: moneyMap(price.imagePrices),
      effectiveAt: dateValue(price.effectiveAt) || new Date()
    })
  }
  return listModelConfiguration(event)
}
