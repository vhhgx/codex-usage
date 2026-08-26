import { and, asc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { ChannelProtocol, ProbeModelCatalogView } from '#shared/types/hub'
import { useDatabase } from '../db'
import { probeModelCatalog } from '../db/schema'

type Input = Record<string, unknown>
const endpoints: Record<ChannelProtocol, string> = {
  anthropic_messages: '/v1/messages',
  openai_responses: '/v1/responses',
  openai_chat: '/v1/chat/completions'
}

function protocol(value: unknown): ChannelProtocol {
  if (value === 'anthropic_messages' || value === 'openai_responses' || value === 'openai_chat') return value
  throw createError({ statusCode: 400, message: '请选择有效协议' })
}

function text(value: unknown, field: string, max = 200) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw createError({ statusCode: 400, message: `${field}不能为空` })
  return normalized.slice(0, max)
}

function view(row: typeof probeModelCatalog.$inferSelect): ProbeModelCatalogView {
  return { ...row, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() }
}

export async function listProbeModels(event: H3Event, includeDisabled = false) {
  const db = useDatabase(event)
  const rows = includeDisabled
    ? await db.select().from(probeModelCatalog).orderBy(asc(probeModelCatalog.protocol), asc(probeModelCatalog.sortOrder), asc(probeModelCatalog.vendor), asc(probeModelCatalog.model))
    : await db.select().from(probeModelCatalog).where(eq(probeModelCatalog.enabled, true)).orderBy(asc(probeModelCatalog.protocol), asc(probeModelCatalog.sortOrder), asc(probeModelCatalog.vendor), asc(probeModelCatalog.model))
  return rows.map(view)
}

export async function createProbeModel(event: H3Event, input: Input) {
  const selectedProtocol = protocol(input.protocol)
  const [row] = await useDatabase(event).insert(probeModelCatalog).values({
    vendor: text(input.vendor, '厂商', 80), protocol: selectedProtocol, endpoint: endpoints[selectedProtocol],
    model: text(input.model, '模型 ID'), displayName: text(input.displayName || input.model, '显示名称'),
    enabled: input.enabled !== false, sortOrder: Math.max(0, Math.min(10000, Number(input.sortOrder) || 100))
  }).returning()
  return view(row!)
}

export async function updateProbeModel(event: H3Event, id: string, input: Input) {
  const patch: Partial<typeof probeModelCatalog.$inferInsert> = { updatedAt: new Date() }
  if ('vendor' in input) patch.vendor = text(input.vendor, '厂商', 80)
  if ('model' in input) patch.model = text(input.model, '模型 ID')
  if ('displayName' in input) patch.displayName = text(input.displayName || input.model, '显示名称')
  if ('enabled' in input) patch.enabled = input.enabled === true
  if ('sortOrder' in input) patch.sortOrder = Math.max(0, Math.min(10000, Number(input.sortOrder) || 0))
  if ('protocol' in input) { patch.protocol = protocol(input.protocol); patch.endpoint = endpoints[patch.protocol] }
  const [row] = await useDatabase(event).update(probeModelCatalog).set(patch).where(eq(probeModelCatalog.id, id)).returning()
  if (!row) throw createError({ statusCode: 404, message: '探测模型不存在' })
  return view(row)
}

export async function deleteProbeModel(event: H3Event, id: string) {
  const [row] = await useDatabase(event).delete(probeModelCatalog).where(and(eq(probeModelCatalog.id, id))).returning({ id: probeModelCatalog.id })
  if (!row) throw createError({ statusCode: 404, message: '探测模型不存在' })
}
