import type {
  CodexRadarModel,
  CodexRadarResponse
} from '../types/codex-radar'

type UnknownRecord = Record<string, unknown>

export const CODEX_RADAR_URL = 'https://codexradar.com/current.json'
export const CODEX_RADAR_INTELLIGENCE_URL = 'https://codexradar.com/data/intelligence-efficiency.json'

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function nonNegative(value: unknown) {
  const parsed = numberValue(value)
  return parsed === null ? null : Math.max(0, parsed)
}

function modelFrom(value: unknown, fallbackId: string): CodexRadarModel | null {
  const item = record(value)
  if (!item) return null
  const model = text(item.model)
  const reasoningEffort = text(item.reasoning_effort)
  const intelligenceScore = numberValue(item.score)
  const passed = nonNegative(item.passed)
  const tasks = nonNegative(item.tasks)
  const costUsd = nonNegative(item.cost_usd)
  const wallSeconds = nonNegative(item.wall_seconds)
  if (!model || !reasoningEffort || intelligenceScore === null || passed === null ||
    tasks === null || costUsd === null || wallSeconds === null) return null

  return {
    id: `${model}:${reasoningEffort}:${fallbackId}`,
    model,
    reasoningEffort,
    intelligenceScore,
    passed: Math.round(passed),
    tasks: Math.round(tasks),
    costUsd,
    wallSeconds
  }
}

function intelligenceModelFrom(value: unknown, fallbackId: string): CodexRadarModel | null {
  const item = record(value)
  if (!item) return null
  const model = text(item.model)
  const reasoningEffort = text(item.effort)
  const intelligenceScore = numberValue(item.iq)
  const passed = nonNegative(item.passed)
  const tasks = nonNegative(item.valid_tasks)
  const costUsd = nonNegative(item.average_price_usd)
  const averageMinutes = nonNegative(item.average_minutes)
  if (!model || !reasoningEffort || intelligenceScore === null || passed === null ||
    tasks === null || costUsd === null || averageMinutes === null) return null

  return {
    id: `${model}:${reasoningEffort}:${fallbackId}`,
    model,
    reasoningEffort,
    intelligenceScore,
    passed: Math.round(passed),
    tasks: Math.round(tasks),
    costUsd,
    wallSeconds: averageMinutes * 60
  }
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(text(value))
  return Number.isNaN(parsed) ? null : parsed
}

export function parseCodexRadarPayload(
  payload: unknown,
  now = Date.now()
): CodexRadarResponse {
  const root = record(payload)
  const points = root?.points
  if (Array.isArray(points)) {
    const models: CodexRadarModel[] = []
    const seen = new Set<string>()
    points.forEach((point, index) => {
      const model = intelligenceModelFrom(point, `point-${index}`)
      if (!model) return
      const key = `${model.model}:${model.reasoningEffort}`
      if (seen.has(key)) return
      seen.add(key)
      models.push(model)
    })

    if (!models.length) throw new Error('CodexRadar 没有可用的模型评分')
    return {
      models,
      updatedAt: timestamp(root?.source_updated_at),
      fetchedAt: now,
      sourceUrl: CODEX_RADAR_INTELLIGENCE_URL
    }
  }

  const modelIq = record(root?.model_iq)
  if (!modelIq) throw new Error('CodexRadar 响应缺少 model_iq')

  const models: CodexRadarModel[] = []
  const seen = new Set<string>()
  const add = (model: CodexRadarModel | null) => {
    if (!model) return
    const key = `${model.model}:${model.reasoningEffort}`
    if (seen.has(key)) return
    seen.add(key)
    models.push(model)
  }

  add(modelFrom(modelIq.latest, 'latest'))
  const comparisons = record(modelIq.comparisons)
  if (comparisons) {
    Object.entries(comparisons).forEach(([key, value]) => {
      const comparison = record(value)
      add(modelFrom(comparison?.latest ?? comparison, key))
    })
  }

  if (!models.length) throw new Error('CodexRadar 没有可用的模型评分')

  return {
    models,
    updatedAt: timestamp(modelIq.updated_at) ?? timestamp(record(modelIq.latest)?.date),
    fetchedAt: now,
    sourceUrl: CODEX_RADAR_URL
  }
}
