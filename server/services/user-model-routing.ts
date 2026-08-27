import { and, asc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import type { UserModelRoutePolicyView, UserRadarPreferenceView } from '#shared/types/hub'
import { useDatabase } from '../db'
import { channelModels, userModelRoutePolicies, userModelSourcePreferences, userRoutePreferences } from '../db/schema'

function cleanModel(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

function modelList(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(cleanModel).filter(Boolean))].slice(0, 100)
}

function sourceList(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => typeof item === 'string' ? item.trim().slice(0, 200) : '').filter(Boolean))].slice(0, 500)
}

export async function listUserModelRouting(event: H3Event, userId: string) {
  const db = useDatabase(event)
  const [policies, sources, [preference], models] = await Promise.all([
    db.select().from(userModelRoutePolicies).where(eq(userModelRoutePolicies.userId, userId)).orderBy(asc(userModelRoutePolicies.requestedModel)),
    db.select().from(userModelSourcePreferences).where(eq(userModelSourcePreferences.userId, userId)).orderBy(asc(userModelSourcePreferences.requestedModel), asc(userModelSourcePreferences.actualModel)),
    db.select().from(userRoutePreferences).where(eq(userRoutePreferences.userId, userId)).limit(1),
    db.selectDistinct({ model: channelModels.publicModel }).from(channelModels).where(eq(channelModels.enabled, true)).orderBy(asc(channelModels.publicModel))
  ])
  return {
    models: models.map(item => item.model),
    radar: { enabled: preference?.radarEnabled === true, maxEffort: preference?.radarMaxEffort || 'high' } satisfies UserRadarPreferenceView,
    policies: policies.map(policy => ({
      requestedModel: policy.requestedModel,
      substitutionEnabled: policy.substitutionEnabled,
      orderedSubstituteModels: policy.orderedSubstituteModels,
      sources: sources.filter(item => item.requestedModel === policy.requestedModel).map(item => ({ actualModel: item.actualModel, orderMode: item.orderMode === 'price_asc' ? 'price_asc' as const : 'manual' as const, orderedSourceIds: item.orderedSourceIds }))
    })) satisfies UserModelRoutePolicyView[]
  }
}

export async function updateUserModelRouting(event: H3Event, userId: string, body: Record<string, unknown>) {
  const db = useDatabase(event)
  const radar = body.radar && typeof body.radar === 'object' ? body.radar as Record<string, unknown> : null
  const now = new Date()
  if (radar) {
    const maxEffort = cleanModel(radar.maxEffort) || 'high'
    await db.insert(userRoutePreferences).values({ userId, orderedSourceIds: [], radarEnabled: radar.enabled === true, radarMaxEffort: maxEffort, updatedAt: now }).onConflictDoUpdate({ target: userRoutePreferences.userId, set: { radarEnabled: radar.enabled === true, radarMaxEffort: maxEffort, updatedAt: now } })
  }
  if ('policies' in body) {
    if (!Array.isArray(body.policies)) throw createError({ statusCode: 400, message: '模型路由策略格式无效' })
    const policies = body.policies.slice(0, 200).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const item = raw as Record<string, unknown>
      const requestedModel = cleanModel(item.requestedModel)
      if (!requestedModel) return []
      const substitutes = modelList(item.orderedSubstituteModels).filter(model => model !== requestedModel)
      const rawSources = Array.isArray(item.sources) ? item.sources : []
      return [{ requestedModel, substitutionEnabled: item.substitutionEnabled === true, orderedSubstituteModels: substitutes, sources: rawSources }]
    })
    await db.transaction(async (tx) => {
      await tx.delete(userModelSourcePreferences).where(eq(userModelSourcePreferences.userId, userId))
      await tx.delete(userModelRoutePolicies).where(eq(userModelRoutePolicies.userId, userId))
      if (policies.length) await tx.insert(userModelRoutePolicies).values(policies.map(item => ({ userId, requestedModel: item.requestedModel, substitutionEnabled: item.substitutionEnabled, orderedSubstituteModels: item.orderedSubstituteModels })))
      const sourceRows = policies.flatMap(policy => policy.sources.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return []
        const item = raw as Record<string, unknown>
        const actualModel = cleanModel(item.actualModel)
        if (!actualModel || actualModel !== policy.requestedModel && !policy.orderedSubstituteModels.includes(actualModel)) return []
        return [{ userId, requestedModel: policy.requestedModel, actualModel, orderMode: item.orderMode === 'price_asc' ? 'price_asc' : 'manual', orderedSourceIds: sourceList(item.orderedSourceIds) }]
      }))
      if (sourceRows.length) await tx.insert(userModelSourcePreferences).values(sourceRows)
    })
  }
  return listUserModelRouting(event, userId)
}

export async function userModelRouteLanes(event: H3Event, userId: string, requestedModel: string) {
  const db = useDatabase(event)
  const [policy] = await db.select().from(userModelRoutePolicies).where(and(eq(userModelRoutePolicies.userId, userId), eq(userModelRoutePolicies.requestedModel, requestedModel))).limit(1)
  const sources = await db.select().from(userModelSourcePreferences).where(and(eq(userModelSourcePreferences.userId, userId), eq(userModelSourcePreferences.requestedModel, requestedModel)))
  const models = [requestedModel, ...(policy?.substitutionEnabled ? policy.orderedSubstituteModels : [])]
  return models.map(actualModel => {
    const source = sources.find(item => item.actualModel === actualModel)
    return { actualModel, substitution: actualModel !== requestedModel, orderMode: source?.orderMode === 'price_asc' ? 'price_asc' as const : 'manual' as const, orderedSourceIds: source?.orderedSourceIds || [] }
  })
}

export async function userRadarPreference(event: H3Event, userId: string) {
  const [row] = await useDatabase(event).select({ enabled: userRoutePreferences.radarEnabled, maxEffort: userRoutePreferences.radarMaxEffort }).from(userRoutePreferences).where(eq(userRoutePreferences.userId, userId)).limit(1)
  return { enabled: row?.enabled === true, maxEffort: row?.maxEffort || 'high' }
}
