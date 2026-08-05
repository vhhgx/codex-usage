import { desc } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { modelPools, modelPrices } from '../db/schema'
import { sub2ApiAdminFetch } from './sub2api-admin'

type UnknownRecord = Record<string, unknown>

export interface ImportedModelPrice {
  inputPerMillion: string
  outputPerMillion: string
  cachedPerMillion: string
  reasoningPerMillion: string
  imagePrices: Record<string, number>
  hasUnmappedImageTokenPrice: boolean
  hasUnmappedCacheWritePrice: boolean
}

function perMillion(value: unknown) {
  const amount = Number(value)
  return String(Number.isFinite(amount) && amount >= 0 ? amount * 1_000_000 : 0)
}

function positive(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0
}

export function normalizeSub2ApiModelPrice(raw: UnknownRecord, imagePrices: Record<string, number>): ImportedModelPrice | null {
  if (raw.found !== true) return null
  const outputPerMillion = perMillion(raw.output_price)
  return {
    inputPerMillion: perMillion(raw.input_price),
    outputPerMillion,
    cachedPerMillion: perMillion(raw.cache_read_price),
    reasoningPerMillion: outputPerMillion,
    imagePrices,
    hasUnmappedImageTokenPrice: positive(raw.image_input_price) || positive(raw.image_output_price),
    hasUnmappedCacheWritePrice: positive(raw.cache_write_price)
  }
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : '读取上游价格失败'
}

export async function syncModelPricesFromSub2Api(event: H3Event) {
  const db = useDatabase(event)
  const [pools, existingPrices] = await Promise.all([
    db.select({ publicModel: modelPools.publicModel }).from(modelPools),
    db.select().from(modelPrices).orderBy(desc(modelPrices.effectiveAt))
  ])
  const latestPrices = new Map<string, typeof existingPrices[number]>()
  existingPrices.forEach(price => { if (!latestPrices.has(price.publicModel)) latestPrices.set(price.publicModel, price) })

  const results = await Promise.all(pools.map(async ({ publicModel }) => {
    try {
      const raw = await sub2ApiAdminFetch<UnknownRecord>(event, '/channels/model-pricing', { query: { model: publicModel } })
      return { publicModel, price: normalizeSub2ApiModelPrice(raw, latestPrices.get(publicModel)?.imagePrices || {}), error: null }
    } catch (error) {
      return { publicModel, price: null, error: failureMessage(error) }
    }
  }))

  const successfulRequests = results.filter(result => !result.error)
  if (pools.length && !successfulRequests.length) {
    throw createError({ statusCode: 502, message: results[0]?.error || '无法读取 Sub2API 模型价格' })
  }

  const effectiveAt = new Date()
  const imported = results.filter((result): result is typeof result & { price: ImportedModelPrice } => Boolean(result.price))
  if (imported.length) {
    await db.insert(modelPrices).values(imported.map(({ publicModel, price }) => ({
      publicModel,
      inputPerMillion: price.inputPerMillion,
      outputPerMillion: price.outputPerMillion,
      cachedPerMillion: price.cachedPerMillion,
      reasoningPerMillion: price.reasoningPerMillion,
      imagePrices: price.imagePrices,
      effectiveAt
    })))
  }

  return {
    source: 'sub2api' as const,
    total: pools.length,
    updated: imported.length,
    unavailable: results.filter(result => !result.error && !result.price).map(result => result.publicModel),
    failed: results.filter(result => result.error).map(result => ({ model: result.publicModel, message: result.error! })),
    imageTokenPricingNotImported: imported.filter(result => result.price.hasUnmappedImageTokenPrice).map(result => result.publicModel),
    cacheWritePricingNotImported: imported.filter(result => result.price.hasUnmappedCacheWritePrice).map(result => result.publicModel),
    effectiveAt: effectiveAt.getTime()
  }
}
