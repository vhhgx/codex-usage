import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import {
  channelModels,
  channelModelBindings,
  channelProtocolBindings,
  channels,
  groupChannelRules,
  groupMemberships,
  groupModelRules,
  groups,
  hubKeyCredentials,
  hubKeys,
  keyModelRules,
  modelPrices,
  modelPools,
  servicePlanVersions,
  usageRollups,
  userPoolAccounts,
  userPoolGroups,
  requestAttempts,
  requestLogs,
  users
} from '../db/schema'
import { contentHash, decryptChannelSecret, hashCacheAffinity, hashClientIp, hashHubKey } from '../utils/hub-crypto'
import { storeEncryptedBody, storeEncryptedStream } from '../utils/object-storage'
import {
  acquireChannel,
  admitHubRequest,
  cancelHubAdmission,
  releaseChannel,
  releaseHubConcurrency,
  renewChannel,
  renewHubConcurrency,
  settleHubRequest,
  type ChannelConcurrencyLease,
  type HubConcurrencyLease
} from './hub-limits'
import { orderedRouteSourceNodes, recordChannelFailure, recordChannelSuccess, rememberAffinitySelection, routeCandidates, selectSupplySource, type SupplyDecision } from './hub-routing'
import { getHubSettings } from './hub-settings'
import { recordUsageRollups } from './hub-rollups'
import { acquireIdempotency, completeIdempotency, failIdempotency } from './hub-idempotency'
import { assertTrafficAccepting } from './hub-traffic'
import { useRedis } from '../utils/redis'
import { trustedClientIp } from '../utils/client-ip'
import { pinnedUpstreamFetch } from '../utils/upstream-url'
import { effectivePriceMultiplier, policyAllows } from './group-policy'
import { getActiveSubscription } from './customer-management'
import { holdUserWallet, releaseUserWallet, settleUserWallet } from './user-wallet'
import { visibleChannels } from './channel-access'
import { getUserFailoverSourceIds } from './user-route-preferences'

const MAX_BODY_BYTES = 50 * 1024 * 1024
const MAX_BUFFERED_BODY_BYTES = 256 * 1024 * 1024
const USAGE_TAIL_BYTES = 4 * 1024 * 1024
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
let bufferedBodyBytes = 0

function timeoutError(message: string) {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

export async function readUpstreamChunk<T>(
  reader: { read: () => Promise<ReadableStreamReadResult<T>> },
  timeoutMs: number,
  controller: AbortController
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError(`Upstream stream was idle for ${timeoutMs} ms`)
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface WritableResponse {
  destroyed: boolean
  writableEnded: boolean
  write: (chunk: Buffer) => boolean
  once: (event: 'drain' | 'close' | 'error', listener: (...args: any[]) => void) => unknown
  off: (event: 'drain' | 'close' | 'error', listener: (...args: any[]) => void) => unknown
}

export async function writeResponseChunk(response: WritableResponse, chunk: Buffer) {
  if (response.destroyed || response.writableEnded) return false
  if (response.write(chunk)) return true
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
    }
    const onDrain = () => { cleanup(); resolve(true) }
    const onClose = () => { cleanup(); resolve(false) }
    const onError = (error: unknown) => { cleanup(); reject(error) }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
  })
}

export interface UsageValue {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  totalTokens: number
  imageCount: number
}

function openAiError(status: number, message: string, type = 'invalid_request_error', code: string | null = null): never {
  throw createError({ statusCode: status, data: { error: { message, type, param: null, code } } })
}

function bearerToken(event: H3Event) {
  const header = getHeader(event, 'authorization') || ''
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
  const apiKey = (getHeader(event, 'x-api-key') || '').trim()
  if (bearer && apiKey && bearer !== apiKey) openAiError(401, 'Conflicting Hub Key headers', 'authentication_error', 'invalid_api_key')
  return bearer || apiKey
}

export async function authenticateHubRequest(event: H3Event) {
  const token = bearerToken(event)
  if (!token) openAiError(401, 'Missing bearer token', 'authentication_error', 'invalid_api_key')
  const db = useDatabase(event)
  const [matched] = await db.select({ key: hubKeys, credential: hubKeyCredentials })
    .from(hubKeyCredentials)
    .innerJoin(hubKeys, eq(hubKeyCredentials.keyId, hubKeys.id))
    .where(eq(hubKeyCredentials.keyHash, hashHubKey(token, event))).limit(1)
  const key = matched?.key
  if (key) event.context.hubKeyId = key.id
  if (matched) event.context.hubKeyCredentialId = matched.credential.id
  if (!key || !matched || matched.credential.status !== 'active' || key.status !== 'active') return openAiError(401, 'Invalid or disabled Hub Key', 'authentication_error', 'invalid_api_key')
  if (matched.credential.expiresAt && matched.credential.expiresAt <= new Date()) {
    await db.update(hubKeyCredentials).set({ status: 'expired', updatedAt: new Date() }).where(eq(hubKeyCredentials.id, matched.credential.id))
    openAiError(401, 'Hub Key credential has expired', 'authentication_error', 'key_credential_expired')
  }
  if (key.expiresAt && key.expiresAt <= new Date()) {
    await db.update(hubKeys).set({ status: 'expired', updatedAt: new Date() }).where(eq(hubKeys.id, key.id))
    openAiError(401, 'Hub Key has expired', 'authentication_error', 'key_expired')
  }
  if (!key.ownerUserId || !key.groupId) return openAiError(401, 'Hub Key ownership is incomplete', 'authentication_error', 'invalid_api_key')
  const [[owner], [group], [membership]] = await Promise.all([
    db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, key.ownerUserId)).limit(1),
    db.select().from(groups).where(eq(groups.id, key.groupId)).limit(1),
    db.select({ id: groupMemberships.id }).from(groupMemberships).where(and(
      eq(groupMemberships.userId, key.ownerUserId),
      eq(groupMemberships.groupId, key.groupId)
    )).limit(1)
  ])
  if (!owner || owner.status !== 'active' || !group || group.status !== 'active' || !membership) {
    return openAiError(401, 'Hub Key owner or group is disabled', 'authentication_error', 'invalid_api_key')
  }
  event.context.hubUserId = owner.id
  event.context.hubGroupId = group.id
  return { key, group, userId: owner.id }
}

export async function touchKeyCredential(event: H3Event, keyId: string) {
  const now = new Date()
  const db = useDatabase(event)
  await db.update(hubKeys).set({ lastUsedAt: now, updatedAt: now }).where(eq(hubKeys.id, keyId))
  const credentialId = typeof event.context.hubKeyCredentialId === 'string' ? event.context.hubKeyCredentialId : null
  if (credentialId) await db.update(hubKeyCredentials).set({ lastUsedAt: now, updatedAt: now }).where(eq(hubKeyCredentials.id, credentialId))
}

export function endpointName(path: string) {
  const normalized = `/v1/${path.replace(/^\/+|\/+$/g, '')}`
  const supported = new Set([
    '/v1/models',
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/embeddings',
    '/v1/images/generations',
    '/v1/images/edits'
  ])
  if (!supported.has(normalized)) openAiError(404, `Unsupported endpoint: ${normalized}`, 'invalid_request_error', 'unsupported_endpoint')
  return normalized
}

interface MultipartFieldRange { name: string; start: number; end: number; value: string }

function multipartFieldRanges(raw: Buffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]
  if (!boundary) return []
  const delimiter = Buffer.from(`--${boundary}`)
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`)
  const headerSeparator = Buffer.from('\r\n\r\n')
  const fields: MultipartFieldRange[] = []
  let delimiterStart = raw.indexOf(delimiter)
  while (delimiterStart >= 0) {
    const headersStart = delimiterStart + delimiter.length + 2
    const headersEnd = raw.indexOf(headerSeparator, headersStart)
    if (headersEnd < 0) break
    const end = raw.indexOf(nextDelimiter, headersEnd + headerSeparator.length)
    if (end < 0) break
    const headers = raw.subarray(headersStart, headersEnd).toString('latin1')
    const disposition = headers.split(/\r\n/).find(line => /^content-disposition:/i.test(line)) || ''
    const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1]
    const isFile = /(?:^|;)\s*filename=/i.test(disposition)
    const start = headersEnd + headerSeparator.length
    if (name && !isFile) {
      fields.push({ name, start, end, value: raw.subarray(start, end).toString('utf8').trim() })
    }
    delimiterStart = end + 2
    if (raw.subarray(delimiterStart + delimiter.length, delimiterStart + delimiter.length + 2).toString() === '--') break
  }
  return fields
}

export function replaceMultipartModel(raw: Buffer, contentType: string, model: string) {
  const range = multipartFieldRanges(raw, contentType).find(field => field.name === 'model')
  if (!range) return raw
  return Buffer.concat([raw.subarray(0, range.start), Buffer.from(model), raw.subarray(range.end)])
}

function bodyModel(raw: Buffer, contentType: string) {
  if (contentType.includes('application/json')) {
    try {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      return { model: typeof body.model === 'string' ? body.model.trim() : '', json: body, metadata: body }
    } catch {
      openAiError(400, 'Request body must be valid JSON')
    }
  }
  if (contentType.includes('multipart/form-data')) {
    const fields = Object.fromEntries(multipartFieldRanges(raw, contentType).map(field => [field.name, field.value]))
    return { model: typeof fields.model === 'string' ? fields.model : '', json: null, metadata: fields }
  }
  return { model: '', json: null, metadata: null }
}

function stableOpenAiPrefix(metadata: Record<string, unknown> | null | undefined) {
  if (metadata?.instructions !== undefined) return metadata.instructions
  if (!Array.isArray(metadata?.messages)) return null
  const prefix = []
  for (const rawMessage of metadata.messages) {
    if (!rawMessage || typeof rawMessage !== 'object') break
    const message = rawMessage as Record<string, unknown>
    if (message.role !== 'system' && message.role !== 'developer') break
    prefix.push(message)
  }
  return prefix.length ? prefix : null
}

const ARCHIVE_SECRET_FIELDS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'xapikey', 'apikey',
  'accesstoken', 'refreshtoken', 'clientsecret'
])

function archiveFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function redactArchiveValue(value: unknown, depth = 0): unknown {
  if (depth > 50 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redactArchiveValue(item, depth + 1))
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    ARCHIVE_SECRET_FIELDS.has(archiveFieldName(key)) ? '[REDACTED]' : redactArchiveValue(item, depth + 1)
  ]))
}

export function sanitizeArchiveBody(raw: Buffer, contentType: string) {
  if (!contentType.toLowerCase().includes('application/json')) return raw
  try {
    return Buffer.from(JSON.stringify(redactArchiveValue(JSON.parse(raw.toString('utf8')))))
  } catch {
    return raw
  }
}

function upstreamHeaders(event: H3Event, apiKey: string, authScheme: 'bearer' | 'x_api_key' = 'bearer', apiVersion?: string | null) {
  const headers = new Headers()
  const requestHeaders = getRequestHeaders(event)
  const connectionTokens = String(requestHeaders.connection || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set([
    'authorization', 'proxy-authorization', 'x-api-key', 'host', 'content-length', 'connection', 'cookie',
    'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade', 'forwarded', 'x-forwarded-for',
    'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip', 'idempotency-key', ...connectionTokens
  ])
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) headers.set(name, String(value))
  }
  if (authScheme === 'x_api_key') {
    headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', apiVersion || '2023-06-01')
  } else headers.set('authorization', `Bearer ${apiKey}`)
  headers.set('accept-encoding', 'identity')
  return headers
}

function responseHeaders(event: H3Event, response: Response, requestId: string) {
  const connectionTokens = String(response.headers.get('connection') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set(['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'set-cookie', 'keep-alive', 'proxy-authenticate', 'te', 'trailer', 'upgrade', ...connectionTokens])
  for (const [name, value] of response.headers.entries()) {
    if (!blocked.has(name.toLowerCase())) setResponseHeader(event, name, value)
  }
  setResponseHeader(event, 'x-request-id', requestId)
  setResponseStatus(event, response.status, response.statusText)
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function imageRequestOptions(request: Record<string, unknown> | null) {
  const imageTool = Array.isArray(request?.tools)
    ? request.tools.map(usageRecord).find(tool => tool?.type === 'image_generation')
    : null
  return {
    size: typeof request?.size === 'string' ? request.size : typeof imageTool?.size === 'string' ? imageTool.size : '1024x1024',
    quality: typeof request?.quality === 'string' ? request.quality : typeof imageTool?.quality === 'string' ? imageTool.quality : 'auto'
  }
}

function extractUsageFromObject(payload: Record<string, unknown>): UsageValue {
  const response = usageRecord(payload.response)
  const usage = usageRecord(payload.usage) || usageRecord(response?.usage) || {}
  const inputDetails = usageRecord(usage.input_tokens_details) || usageRecord(usage.prompt_tokens_details) || {}
  const outputDetails = usageRecord(usage.output_tokens_details) || usageRecord(usage.completion_tokens_details) || {}
  const inputTokens = numberValue(usage.input_tokens ?? usage.prompt_tokens)
  const outputTokens = numberValue(usage.output_tokens ?? usage.completion_tokens)
  const cachedTokens = numberValue(inputDetails.cached_tokens)
  const reasoningTokens = numberValue(outputDetails.reasoning_tokens)
  const data = Array.isArray(payload.data) ? payload.data : Array.isArray(response?.data) ? response.data : []
  const output = Array.isArray(payload.output) ? payload.output : Array.isArray(response?.output) ? response.output : []
  const generatedImages = output.filter((item) => {
    const value = usageRecord(item)
    return value?.type === 'image_generation_call' && typeof value.result === 'string' && value.result.length > 0
  })
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    totalTokens: numberValue(usage.total_tokens) || inputTokens + outputTokens,
    imageCount: data.length || generatedImages.length
  }
}

export function extractUsage(buffer: Buffer, contentType: string): UsageValue {
  const empty = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, imageCount: 0 }
  const text = buffer.toString('utf8')
  if (contentType.includes('text/event-stream')) {
    let latest = empty
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const value = line.slice(5).trim()
      if (!value || value === '[DONE]') continue
      try {
        const usage = extractUsageFromObject(JSON.parse(value))
        if (usage.totalTokens || usage.imageCount) latest = usage
      } catch {}
    }
    return latest
  }
  try { return extractUsageFromObject(JSON.parse(text)) } catch { return empty }
}

export function normalizeUpstreamError(buffer: Buffer, status: number, statusText = '', override = '') {
  if (override) return Buffer.from(JSON.stringify({
    error: { message: override, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: 'upstream_error' }
  }))
  try {
    const payload = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
    const error = usageRecord(payload.error)
    if (error && typeof error.message === 'string') return buffer
    const message = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.error === 'string' ? payload.error : statusText || `Upstream returned HTTP ${status}`
    return Buffer.from(JSON.stringify({
      error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: 'upstream_error' }
    }))
  } catch {
    const raw = buffer.toString('utf8').trim()
    return Buffer.from(JSON.stringify({
      error: {
        message: raw.slice(0, 2000) || statusText || `Upstream returned HTTP ${status}`,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        param: null,
        code: 'upstream_error'
      }
    }))
  }
}

export async function calculateCost(event: H3Event, model: string, usage: UsageValue, request: Record<string, unknown> | null, multipliers: number) {
  const [price] = await useDatabase(event).select().from(modelPrices)
    .where(and(eq(modelPrices.publicModel, model), lte(modelPrices.effectiveAt, new Date())))
    .orderBy(desc(modelPrices.effectiveAt)).limit(1)
  if (!price) return 0
  const tokenCost = (
    Math.max(0, usage.inputTokens - usage.cachedTokens) * Number(price.inputPerMillion) +
    Math.max(0, usage.outputTokens - usage.reasoningTokens) * Number(price.outputPerMillion) +
    usage.cachedTokens * Number(price.cachedPerMillion) +
    usage.reasoningTokens * Number(price.reasoningPerMillion)
  ) / 1_000_000
  const { size, quality } = imageRequestOptions(request)
  const imageUnit = price.imagePrices[`${size}:${quality}`] ?? price.imagePrices[size] ?? 0
  return (tokenCost + usage.imageCount * imageUnit) * multipliers
}

export async function estimateReservation(event: H3Event, model: string, endpoint: string, request: Record<string, unknown> | null, bodyLength: number, multiplier: number) {
  const outputLimit = endpoint === '/v1/embeddings' || endpoint.startsWith('/v1/images/') ? 0 : Math.max(0, numberValue(request?.max_output_tokens ?? request?.max_completion_tokens ?? request?.max_tokens) || 4096)
  const inputEstimate = endpoint.startsWith('/v1/images/') ? 0 : Math.ceil(bodyLength / 4)
  const usesImageTool = endpoint === '/v1/responses' && Array.isArray(request?.tools)
    && request.tools.map(usageRecord).some(tool => tool?.type === 'image_generation')
  const imageCount = endpoint.startsWith('/v1/images/') || usesImageTool ? Math.max(1, numberValue(request?.n) || 1) : 0
  const usage = { inputTokens: inputEstimate, outputTokens: outputLimit, cachedTokens: 0, reasoningTokens: 0, totalTokens: inputEstimate + outputLimit, imageCount }
  return { tokens: usage.totalTokens, cost: await calculateCost(event, model, usage, request, multiplier), imageCount, ...imageRequestOptions(request) }
}

export function enforceRequestProtection(key: typeof hubKeys.$inferSelect, reservation: Awaited<ReturnType<typeof estimateReservation>>) {
  if (key.maxRequestTokens !== null && reservation.tokens > key.maxRequestTokens) {
    openAiError(400, 'Request exceeds this Hub Key token limit', 'invalid_request_error', 'request_token_limit')
  }
  if (key.maxImageCount !== null && reservation.imageCount > key.maxImageCount) {
    openAiError(400, 'Request exceeds this Hub Key image count limit', 'invalid_request_error', 'request_image_limit')
  }
  if (reservation.imageCount > 0 && key.allowedImageSizes.length && !key.allowedImageSizes.includes(reservation.size)) {
    openAiError(403, 'This Hub Key cannot use the requested image size', 'permission_error', 'image_size_not_allowed')
  }
  if (reservation.imageCount > 0 && key.allowedImageQualities.length && !key.allowedImageQualities.includes(reservation.quality)) {
    openAiError(403, 'This Hub Key cannot use the requested image quality', 'permission_error', 'image_quality_not_allowed')
  }
  if (key.maxRequestCost !== null && reservation.cost > Number(key.maxRequestCost)) {
    openAiError(400, 'Request exceeds this Hub Key cost limit', 'invalid_request_error', 'request_cost_limit')
  }
}

export async function storeBodySafe(event: H3Event, requestId: string, kind: 'request' | 'response', body: Buffer, contentType: string) {
  try { return await storeEncryptedBody(event, requestId, kind, body, contentType) } catch { return null }
}

export async function storeFileSafe(event: H3Event, requestId: string, kind: 'request' | 'response', path: string, contentType: string) {
  try { return await storeEncryptedStream(event, requestId, kind, createReadStream(path), contentType) } catch { return null }
}

function appendUsageTail(current: Buffer, chunk: Buffer) {
  if (chunk.length >= USAGE_TAIL_BYTES) return chunk.subarray(chunk.length - USAGE_TAIL_BYTES)
  const combined = Buffer.concat([current, chunk])
  return combined.length > USAGE_TAIL_BYTES ? combined.subarray(combined.length - USAGE_TAIL_BYTES) : combined
}

interface BodyMemoryReservation { bytes: number; released: boolean }

function reserveBodyMemory(event: H3Event, bytes: number) {
  const reservation: BodyMemoryReservation = { bytes: 0, released: false }
  const grow = (target: number) => {
    const delta = Math.max(0, target - reservation.bytes)
    if (bufferedBodyBytes + delta > MAX_BUFFERED_BODY_BYTES) {
      setResponseHeader(event, 'retry-after', 1)
      openAiError(503, 'Gateway request body capacity is temporarily exhausted', 'server_error', 'request_body_capacity')
    }
    bufferedBodyBytes += delta
    reservation.bytes += delta
  }
  grow(bytes)
  const release = () => {
    if (reservation.released) return
    reservation.released = true
    bufferedBodyBytes = Math.max(0, bufferedBodyBytes - reservation.bytes)
  }
  event.node.res.once('close', release)
  return { reservation, grow, release }
}

async function readRequestBodyLimited(event: H3Event, limit: number, memory: ReturnType<typeof reserveBodyMemory>) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of event.node.req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.length
    if (total > limit) {
      event.node.req.resume()
      openAiError(413, 'Request body exceeds 50 MB')
    }
    memory.grow(total)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

export async function listAccessibleModels(event: H3Event, key: typeof hubKeys.$inferSelect, group: typeof groups.$inferSelect, userId: string, protocols: Array<'anthropic_messages' | 'openai_responses' | 'openai_chat'>) {
  const db = useDatabase(event)
  const [rules, groupRules, channelRules] = await Promise.all([
    db.select().from(keyModelRules).where(eq(keyModelRules.keyId, key.id)),
    db.select().from(groupModelRules).where(eq(groupModelRules.groupId, group.id)),
    db.select().from(groupChannelRules).where(eq(groupChannelRules.groupId, group.id))
  ])
  const rows = await db.select({ publicModel: channelModels.publicModel, channelId: channels.id, healthStatus: channels.healthStatus, clientIdentityMode: channels.clientIdentityMode, modelDiscoveryEnabled: channels.modelDiscoveryEnabled, protocol: channelProtocolBindings.protocol })
    .from(channelModelBindings)
    .innerJoin(channelModels, eq(channelModelBindings.channelModelId, channelModels.id))
    .innerJoin(channelProtocolBindings, eq(channelModelBindings.protocolBindingId, channelProtocolBindings.id))
    .innerJoin(channels, eq(channelModels.channelId, channels.id))
    .where(and(eq(channelModels.enabled, true), eq(channelModelBindings.enabled, true), eq(channelProtocolBindings.enabled, true), eq(channels.enabled, true)))
  const pools = await db.select().from(modelPools)
  const disabledPools = new Set(pools.filter(pool => !pool.enabled).map(pool => pool.publicModel))
  const redis = useRedis(event)
  const visibleIds = new Set((await visibleChannels(event, userId, key.id)).map(channel => channel.id))
  const usableRows = []
  const restrictedChannels = channelRules.length > 0
  const enabledChannels = new Set(channelRules.filter(rule => rule.enabled).map(rule => rule.channelId))
  for (const row of rows) {
    const routable = row.healthStatus === 'healthy' || row.healthStatus === 'unknown' && row.clientIdentityMode === 'passthrough' && row.modelDiscoveryEnabled === false
    if (!protocols.includes(row.protocol) || !visibleIds.has(row.channelId) || !routable || disabledPools.has(row.publicModel)) continue
    if (restrictedChannels && !enabledChannels.has(row.channelId)) continue
    if (!await redis.exists(`hub:circuit:${row.channelId}:open`)) usableRows.push(row)
  }
  const keyAllowed = new Set(rules.map(rule => rule.publicModel))
  const groupAllowed = new Set(groupRules.map(rule => rule.publicModel))
  const models = [...new Set(usableRows.map(row => row.publicModel))]
    .filter(model => !keyAllowed.size || keyAllowed.has(model))
    .filter(model => !groupAllowed.size || groupAllowed.has(model))
  return { object: 'list', data: models.sort().map(id => ({ id, object: 'model', created: 0, owned_by: 'zephyr-hub' })) }
}

async function handleModelsRequest(event: H3Event, access: Awaited<ReturnType<typeof authenticateHubRequest>>, requestId: string) {
  const { key, group, userId } = access
  const endpoint = '/v1/models'
  const startedAt = Date.now()
  let concurrencyLease: HubConcurrencyLease
  try {
    concurrencyLease = await admitHubRequest(event, key, group, 0, 0)
  } catch (error) {
    const failure = error as { statusCode?: number; message?: string }
    if (failure.statusCode === 429) {
      openAiError(429, failure.message || 'Hub Key has reached its usage limit', 'rate_limit_error', 'rate_limit_exceeded')
    }
    throw error
  }

  let log: typeof requestLogs.$inferSelect | undefined
  try {
    [log] = await useDatabase(event).insert(requestLogs).values({
      requestId,
      keyId: key.id,
      userId,
      groupId: group.id,
      endpoint,
      status: 'pending',
      clientIpHash: hashClientIp(trustedClientIp(event), event)
    }).returning()
    if (!log) throw new Error('Unable to initialize request log')

    const result = await listAccessibleModels(event, key, group, userId, ['openai_responses', 'openai_chat'])
    const durationMs = Date.now() - startedAt
    await useDatabase(event).update(requestLogs).set({
      status: 'success',
      httpStatus: 200,
      firstByteMs: durationMs,
      durationMs,
      completedAt: new Date()
    }).where(eq(requestLogs.id, log.id))
    await touchKeyCredential(event, key.id)
    await recordUsageRollups(event, {
      keyId: key.id,
      userId,
      groupId: group.id,
      channelId: null,
      model: null,
      endpoint,
      status: 'success',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      durationMs,
      failovers: 0
    })
    return result
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : 'Unable to list models'
    if (log) {
      await useDatabase(event).update(requestLogs).set({
        status: 'error',
        httpStatus: 500,
        durationMs,
        errorMessage: message.slice(0, 2000),
        completedAt: new Date()
      }).where(eq(requestLogs.id, log.id))
      await recordUsageRollups(event, {
        keyId: key.id,
        userId,
        groupId: group.id,
        channelId: null,
        model: null,
        endpoint,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: 0,
        durationMs,
        failovers: 0
      })
    }
    throw error
  } finally {
    await settleHubRequest(event, key, group, 0, 0, 0, 0, concurrencyLease!)
  }
}

export async function handleHubRequest(event: H3Event, path: string) {
  const endpoint = endpointName(path)
  const access = await authenticateHubRequest(event)
  const { key, group, userId } = access
  await assertTrafficAccepting(event)
  if (!policyAllows(key.allowedEndpoints, endpoint)) {
    openAiError(403, 'This Hub Key cannot use the requested endpoint', 'permission_error', 'endpoint_not_allowed')
  }
  if (!policyAllows(group.allowedEndpoints, endpoint)) {
    openAiError(403, 'This group cannot use the requested endpoint', 'permission_error', 'endpoint_not_allowed')
  }
  if (endpoint === '/v1/models') {
    if (event.method !== 'GET') openAiError(405, 'Method not allowed')
    const requestId = typeof event.context.hubRequestId === 'string'
      ? event.context.hubRequestId
      : `req_${crypto.randomUUID().replace(/-/g, '')}`
    return handleModelsRequest(event, access, requestId)
  }
  if (event.method !== 'POST') openAiError(405, 'Method not allowed')
  const contentType = getHeader(event, 'content-type') || 'application/json'
  const declaredLength = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) openAiError(413, 'Request body exceeds 50 MB')
  const memory = reserveBodyMemory(event, Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : 64 * 1024)
  const requestBody = await readRequestBodyLimited(event, MAX_BODY_BYTES, memory)
  const parsed = bodyModel(requestBody, contentType)
  const archivedRequestBody = sanitizeArchiveBody(requestBody, contentType)
  if (!parsed.model) openAiError(400, 'model is required', 'invalid_request_error', 'model_required')
  event.context.hubRequestedModel = parsed.model
  const rules = await useDatabase(event).select().from(keyModelRules).where(eq(keyModelRules.keyId, key.id))
  if (rules.length && !rules.some(rule => rule.publicModel === parsed.model)) openAiError(403, 'This Hub Key cannot use the requested model', 'permission_error', 'model_not_allowed')
  const groupRules = await useDatabase(event).select().from(groupModelRules).where(eq(groupModelRules.groupId, group.id))
  if (groupRules.length && !groupRules.some(rule => rule.publicModel === parsed.model)) openAiError(403, 'This group cannot use the requested model', 'permission_error', 'model_not_allowed')
  const streaming = parsed.json?.stream === true
  const requestId = typeof event.context.hubRequestId === 'string'
    ? event.context.hubRequestId
    : `req_${crypto.randomUUID().replace(/-/g, '')}`
  const idempotency = await acquireIdempotency(event, key.id, endpoint, requestBody, streaming)
  if (idempotency?.replay) {
    const replay = idempotency.replay
    const now = new Date()
    await useDatabase(event).insert(requestLogs).values({
      requestId,
      keyId: key.id,
      userId,
      groupId: group.id,
      endpoint,
      requestedModel: parsed.model,
      inboundProtocol: endpoint === '/v1/responses' ? 'openai_responses' : 'openai_chat',
      status: replay.status >= 200 && replay.status < 400 ? 'success' : 'error',
      httpStatus: replay.status,
      errorCode: 'idempotent_replay',
      durationMs: 0,
      completedAt: now
    })
    await recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: null, model: parsed.model, endpoint, status: replay.status >= 200 && replay.status < 400 ? 'success' : 'error', inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, durationMs: 0, failovers: 0, admitted: false })
    await touchKeyCredential(event, key.id)
    setResponseStatus(event, replay.status)
    setResponseHeader(event, 'content-type', replay.contentType)
    setResponseHeader(event, 'x-idempotent-replayed', 'true')
    return replay.status >= 400 ? normalizeUpstreamError(replay.body, replay.status, '', (await getHubSettings(event)).errorMessageOverrides[String(replay.status)] || '') : replay.body
  }
  let candidates: Awaited<ReturnType<typeof routeCandidates>>
  let supplyDecision: SupplyDecision = { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
  let packageDecision: SupplyDecision | null = null
  let packageBillingMode = 'unlimited'
  let packageAdmissionLease: HubConcurrencyLease | null = null
  let walletHoldKey: string | null = null
  let walletHeld = false
  let affinityKey: string | undefined
  let affinityWasReused = false
  let reservation: Awaited<ReturnType<typeof estimateReservation>>
  let concurrencyLease: HubConcurrencyLease
  try {
    const inboundProtocol: 'openai_responses' | 'openai_chat' = endpoint === '/v1/responses' ? 'openai_responses' : 'openai_chat'
    affinityKey = hashCacheAffinity(event, {
      scope: `${userId}:${key.id}`,
      protocol: inboundProtocol,
      model: parsed.model,
      system: stableOpenAiPrefix(parsed.metadata),
      tools: parsed.metadata?.tools,
      sessionId: getHeader(event, 'x-zephyr-session-id') || null
    })
    const routeOptions = { userId, keyId: key.id, protocol: inboundProtocol, affinityKey }
    const sourceIds = await getUserFailoverSourceIds(event, userId)
    const sourceNodes = orderedRouteSourceNodes(key.routeMode, sourceIds)
    const [privatePool] = await useDatabase(event).select().from(userPoolGroups).where(and(eq(userPoolGroups.ownerUserId, userId), eq(userPoolGroups.status, 'active'))).limit(1)
    const privatePoolAvailable = Boolean(privatePool && (await useDatabase(event).select({ id: userPoolAccounts.id }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, privatePool.id), eq(userPoolAccounts.status, 'active'), eq(userPoolAccounts.schedulable, true))).limit(1))[0])
    const candidateBatches = await Promise.all(sourceNodes.map(async node => ({
      node,
      candidates: node.source === 'platform'
        ? await routeCandidates(event, parsed.model, endpoint, group.id, 'platform', undefined, routeOptions)
        : node.source === 'private_pool'
          ? privatePoolAvailable ? await routeCandidates(event, parsed.model, endpoint, group.id, 'private_pool', privatePool!.id, routeOptions) : []
          : await routeCandidates(event, parsed.model, endpoint, group.id, 'user_relay', undefined, { ...routeOptions, channelId: node.channelId })
    })))
    const initialCandidates = candidateBatches.flatMap(batch => batch.candidates)
    if (!initialCandidates.length) {
      const message = (await getHubSettings(event)).errorMessageOverrides['503'] || `No healthy channel supports model ${parsed.model}`
      openAiError(503, message, 'server_error', 'no_available_channel')
    }
    reservation = await estimateReservation(
      event,
      parsed.model,
      endpoint,
      parsed.metadata,
      requestBody.length,
      effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Math.max(...initialCandidates.map(candidate => Number(candidate.channel.priceMultiplier))))
    )
    const hasPackageNode = candidateBatches.some(batch => batch.node.source === 'platform')
    if (hasPackageNode) {
      const activeSubscription = await getActiveSubscription(event, userId)
      const version = activeSubscription?.subscription.planVersionId
        ? (await useDatabase(event).select().from(servicePlanVersions).where(eq(servicePlanVersions.id, activeSubscription.subscription.planVersionId)).limit(1))[0]
        : null
      const snapshot = activeSubscription?.subscription.entitlementSnapshot || {}
      packageBillingMode = String(version?.billingMode || snapshot.billingMode || (activeSubscription?.plan.mode === 'token' ? 'token_package' : activeSubscription?.plan.mode === 'cost' ? 'token_metered' : 'unlimited'))
      const supplyMode = String(version?.supplyMode || snapshot.supplyMode || 'platform_only')
      const tokenLimit = Number(version?.tokenLimit ?? snapshot.tokenLimit ?? activeSubscription?.plan.tokenLimit ?? 0)
      const usedRow = activeSubscription && tokenLimit > 0
        ? (await useDatabase(event).select({ tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)` }).from(usageRollups).where(and(eq(usageRollups.userId, userId), eq(usageRollups.granularity, 'day'), gte(usageRollups.bucketStart, activeSubscription.subscription.startsAt))))[0]
        : null
      try {
        packageDecision = selectSupplySource({
          billingMode: packageBillingMode,
          supplyMode,
          estimatedTokens: reservation.tokens,
          remainingTokens: tokenLimit > 0 ? Math.max(0, tokenLimit - Number(usedRow?.tokens || 0)) : null,
          privatePoolAvailable,
          subscriptionId: activeSubscription?.subscription.id,
          planVersionId: version?.id || activeSubscription?.subscription.planVersionId,
          poolGroupId: privatePool?.id
        })
      } catch (error) {
        const hasRelayCandidates = candidateBatches.some(batch => batch.node.source === 'user_relay' && batch.candidates.length)
        if (!hasRelayCandidates) throw error
      }
    }
    const orderedCandidates: typeof initialCandidates = []
    for (const batch of candidateBatches) {
      if (batch.node.source === 'user_relay') orderedCandidates.push(...batch.candidates)
      else if (batch.node.source === 'private_pool') orderedCandidates.push(...batch.candidates)
      else if (packageDecision?.source === 'platform') orderedCandidates.push(...batch.candidates)
    }
    candidates = orderedCandidates
    if (!candidates.length) openAiError(503, '没有可用来源支持当前模型', 'server_error', 'no_available_channel')
    supplyDecision = candidates[0]!.supplySource === 'user_relay'
      ? { source: 'user_relay', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
      : candidates[0]!.supplySource === 'private_pool'
        ? { source: 'private_pool', subscriptionId: null, planVersionId: null, reservedTokens: 0, poolGroupId: privatePool?.id }
        : packageDecision || { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    event.context.hubSupplySource = supplyDecision.source
    event.context.hubPoolGroupId = supplyDecision.poolGroupId
    event.context.hubSubscriptionId = supplyDecision.subscriptionId
    event.context.hubPlanVersionId = supplyDecision.planVersionId
    enforceRequestProtection(key, reservation)
    concurrencyLease = await admitHubRequest(event, key, group, reservation.tokens, 0, { scopeMode: 'base_only' })
    affinityWasReused = candidates[0]?.affinityReused === true
  } catch (error) {
    if (idempotency) await failIdempotency(event, idempotency.record.id, false).catch(() => {})
    if (walletHeld && walletHoldKey) { await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {}); walletHeld = false }
    const failure = error as { statusCode?: number; message?: string }
    if (failure.statusCode === 429) {
      openAiError(429, failure.message || 'Hub Key has reached its usage limit', 'rate_limit_error', 'rate_limit_exceeded')
    }
    throw error
  }
  const startedAt = Date.now()
  const settings = await getHubSettings(event)
  let log: typeof requestLogs.$inferSelect | undefined
  try {
    [log] = await useDatabase(event).insert(requestLogs).values({
      requestId,
      keyId: key.id,
      userId,
      groupId: group.id,
      endpoint,
      requestedModel: parsed.model,
      inboundProtocol: endpoint === '/v1/responses' ? 'openai_responses' : 'openai_chat',
      status: 'pending',
      streaming,
      supplySource: supplyDecision.source,
      poolGroupId: supplyDecision.poolGroupId || null,
      subscriptionId: supplyDecision.subscriptionId,
      planVersionId: supplyDecision.planVersionId,
      billableTokens: reservation.tokens,
      billedAmount: String(supplyDecision.source === 'user_relay' ? 0 : reservation.cost),
      clientIpHash: hashClientIp(trustedClientIp(event), event),
      requestBodyHash: contentHash(archivedRequestBody),
      bodyExpiresAt: new Date(Date.now() + settings.bodyRetentionDays * 24 * 60 * 60 * 1000)
    }).returning()
  } catch (error) {
    await settleHubRequest(event, key, group, 0, 0, reservation.tokens, 0, concurrencyLease!)
    if (walletHeld && walletHoldKey) { await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {}); walletHeld = false }
    if (idempotency) await failIdempotency(event, idempotency.record.id, false).catch(() => {})
    throw error
  }
  if (!log) {
    await settleHubRequest(event, key, group, 0, 0, reservation.tokens, 0, concurrencyLease!)
    if (walletHeld && walletHoldKey) { await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {}); walletHeld = false }
    throw createError({ statusCode: 500, message: 'Unable to initialize request log' })
  }
  const requestObject = await storeBodySafe(event, requestId, 'request', archivedRequestBody, contentType)
  if (requestObject) await useDatabase(event).update(requestLogs).set({ requestBodyObject: requestObject }).where(eq(requestLogs.id, log.id))

  let admittedChannel: ChannelConcurrencyLease | null = null
  let lastCandidate: typeof candidates[number] | null = null
  let attemptCount = 0
  let settled = false
  let responseStarted = false
  let upstreamRequestStarted = false
  let packageAdmissionError: unknown = null

  async function releasePackageReservation() {
    if (packageAdmissionLease) {
      await cancelHubAdmission(event, packageAdmissionLease, reservation.tokens, reservation.cost).catch(() => {})
      packageAdmissionLease = null
    }
    if (walletHeld && walletHoldKey) {
      await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
      walletHeld = false
    }
  }

  async function activateCandidateSupply(candidate: typeof candidates[number]) {
    const nextDecision: SupplyDecision = candidate.supplySource === 'user_relay'
      ? { source: 'user_relay', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
      : packageDecision || { source: candidate.supplySource, subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    if (nextDecision.source === 'user_relay') {
      await releasePackageReservation()
    } else if (packageAdmissionError) {
      return false
    } else {
      try {
        if (nextDecision.source === 'platform' && !packageAdmissionLease) {
          packageAdmissionLease = await admitHubRequest(event, key, group, reservation.tokens, reservation.cost, { scopeMode: 'subscription_only' })
        }
        if (packageBillingMode === 'token_metered' && reservation.cost > 0 && !walletHeld) {
          walletHoldKey ||= `request:${requestId}:hold`
          await holdUserWallet(event, userId, reservation.cost, walletHoldKey, requestId)
          walletHeld = true
        }
      } catch (error) {
        packageAdmissionError = error
        await releasePackageReservation()
        return false
      }
    }
    supplyDecision = nextDecision
    event.context.hubSupplySource = supplyDecision.source
    event.context.hubPoolGroupId = supplyDecision.poolGroupId
    event.context.hubSubscriptionId = supplyDecision.subscriptionId
    event.context.hubPlanVersionId = supplyDecision.planVersionId
    await useDatabase(event).update(requestLogs).set({
      supplySource: supplyDecision.source,
      poolGroupId: supplyDecision.poolGroupId || null,
      subscriptionId: supplyDecision.subscriptionId,
      planVersionId: supplyDecision.planVersionId,
      billedAmount: String(supplyDecision.source === 'user_relay' ? 0 : reservation.cost)
    }).where(eq(requestLogs.id, log!.id))
    return true
  }

  async function settleAdmissions(totalTokens: number, cost: number) {
    await settleHubRequest(event, key, group, totalTokens, cost, reservation.tokens, 0, concurrencyLease)
    if (packageAdmissionLease) {
      await settleHubRequest(event, key, group, totalTokens, cost, reservation.tokens, reservation.cost, packageAdmissionLease)
      packageAdmissionLease = null
    }
  }

  try {
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!
      const channelLease = await acquireChannel(event, candidate.channel.id, candidate.channel.maxConcurrency)
      if (!channelLease) continue
      if (!await activateCandidateSupply(candidate)) {
        await releaseChannel(event, channelLease)
        continue
      }
      affinityWasReused = candidate.affinityReused === true
      lastCandidate = candidate
      attemptCount += 1
      admittedChannel = channelLease
      const attemptStarted = Date.now()
      let upstreamHeadersReceived = false
      let closePinnedConnection: (() => Promise<void>) | null = null
      const closePinned = async () => {
        const close = closePinnedConnection
        if (close) await close().catch(() => {})
      }
      const upstreamAbort = new AbortController()
      const upstreamTimeout = setTimeout(() => {
        upstreamAbort.abort(timeoutError(`Upstream request timed out after ${candidate.channel.timeoutMs} ms`))
      }, candidate.channel.timeoutMs)
      upstreamTimeout.unref()
      const stopUpstreamTimeout = () => clearTimeout(upstreamTimeout)
      try {
        let outgoing: Buffer<ArrayBufferLike> = requestBody
        if (parsed.json) {
          const payload: Record<string, unknown> = { ...parsed.json, model: candidate.upstreamModel }
          if (streaming && endpoint === '/v1/chat/completions') {
            payload.stream_options = { ...(usageRecord(payload.stream_options) || {}), include_usage: true }
          }
          outgoing = Buffer.from(JSON.stringify(payload))
        } else if (contentType.includes('multipart/form-data')) {
          outgoing = replaceMultipartModel(requestBody, contentType, candidate.upstreamModel)
        }
        const upstreamBase = (candidate.protocolBinding.baseUrlOverride || candidate.channel.baseUrl).replace(/\/+$/, '').replace(/\/v1$/i, '')
        const credential = candidate.credential || decryptChannelSecret(candidate.channel.encryptedApiKey, candidate.channel.id, candidate.channel.ownerKind, event)
        const headers = upstreamHeaders(event, credential, candidate.protocolBinding.authScheme, candidate.protocolBinding.apiVersion)
        upstreamRequestStarted = true
        const response = candidate.channel.ownerKind === 'user'
          ? await (async () => {
              const result = await pinnedUpstreamFetch(upstreamBase, endpoint, { method: 'POST', headers, body: outgoing, signal: upstreamAbort.signal })
              closePinnedConnection = result.close
              return result.response as unknown as Response
            })()
          : await fetch(`${upstreamBase}${endpoint}`, { method: 'POST', headers, body: outgoing as unknown as BodyInit, redirect: 'manual', signal: upstreamAbort.signal })
        upstreamHeadersReceived = true
        const retryable = RETRYABLE_STATUS.has(response.status)
        if (retryable && index < candidates.length - 1) {
          const errorText = (await response.text()).slice(0, 1000)
          await closePinned()
          stopUpstreamTimeout()
          await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, attempt: attemptCount, status: 'failed', httpStatus: response.status, durationMs: Date.now() - attemptStarted, errorMessage: errorText })
          await recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`)
          await releaseChannel(event, channelLease)
          admittedChannel = null
          continue
        }

        let firstByteMs: number | null = null
        const responseContentType = response.headers.get('content-type') || 'application/octet-stream'
        if (streaming && response.ok && response.body) {
          stopUpstreamTimeout()
          responseStarted = true
          responseHeaders(event, response, requestId)
          const temporaryDirectory = await mkdtemp(join(tmpdir(), 'zephyr-hub-response-'))
          const temporaryPath = join(temporaryDirectory, 'body')
          const archive = createWriteStream(temporaryPath, { flags: 'wx' })
          const responseHash = createHash('sha256')
          let usageTail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
          const reader = response.body.getReader()
          let clientAborted = false
          let streamError: Error | null = null
          const markAborted = () => {
            if (clientAborted) return
            clientAborted = true
            const reason = new Error('Client connection closed')
            upstreamAbort.abort(reason)
            void reader.cancel(reason).catch(() => {})
          }
          event.node.res.once('close', markAborted)
          try {
            while (true) {
              const { done, value } = await readUpstreamChunk(reader, candidate.channel.timeoutMs, upstreamAbort)
              if (done) break
              const chunk = Buffer.from(value)
              if (firstByteMs === null) firstByteMs = Date.now() - startedAt
              responseHash.update(chunk)
              usageTail = appendUsageTail(usageTail, chunk)
              if (!archive.write(chunk)) await once(archive, 'drain')
              if (!clientAborted && !await writeResponseChunk(event.node.res, chunk)) {
                markAborted()
                break
              }
              await Promise.all([
                renewHubConcurrency(event, concurrencyLease),
                ...(packageAdmissionLease ? [renewHubConcurrency(event, packageAdmissionLease)] : []),
                renewChannel(event, channelLease)
              ])
            }
          } catch (error) {
            if (!clientAborted) streamError = error instanceof Error ? error : new Error('Upstream stream was interrupted')
          } finally {
            event.node.res.off('close', markAborted)
            archive.end()
            await once(archive, 'finish').catch(() => {})
            await closePinned()
            try {
              await releaseHubConcurrency(event, concurrencyLease)
            } catch {}
            try {
              await releaseChannel(event, channelLease)
              admittedChannel = null
            } catch {}
            if (!event.node.res.writableEnded) event.node.res.end()
          }
          const usage = extractUsage(usageTail, responseContentType)
          const streamAborted = clientAborted || Boolean(streamError)
          const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, parsed.model, usage, parsed.metadata, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
          const responseObject = await storeFileSafe(event, requestId, 'response', temporaryPath, responseContentType)
          await rm(temporaryDirectory, { recursive: true, force: true })
          await useDatabase(event).insert(requestAttempts).values({
            requestLogId: log.id,
            channelId: candidate.channel.id,
            protocolBindingId: candidate.protocolBinding.id,
            attempt: attemptCount,
            status: streamAborted ? 'stream_aborted' : 'success',
            httpStatus: response.status,
            durationMs: Date.now() - attemptStarted,
            errorMessage: streamError?.message.slice(0, 2000)
          })
          await useDatabase(event).update(requestLogs).set({
            channelId: candidate.channel.id,
            protocolBindingId: candidate.protocolBinding.id,
            outboundProtocol: candidate.protocolBinding.protocol,
            conversionMode: candidate.conversionMode,
            sourceOwnerKind: candidate.channel.ownerKind,
            sourceOwnerUserId: candidate.channel.ownerUserId,
            cacheAffinityReused: affinityWasReused,
            upstreamModel: candidate.upstreamModel,
            status: streamAborted ? 'stream_aborted' : 'success',
            httpStatus: response.status,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            reasoningTokens: usage.reasoningTokens,
            totalTokens: usage.totalTokens,
            imageCount: usage.imageCount,
            cost: String(cost),
            billableTokens: usage.totalTokens,
            billedAmount: String(cost),
            pricingSnapshot: { model: parsed.model, channelMultiplier: Number(candidate.channel.priceMultiplier), groupMultiplier: Number(group.priceMultiplier), keyMultiplier: Number(key.priceMultiplier) },
            firstByteMs: firstByteMs ?? Date.now() - startedAt,
            durationMs: Date.now() - startedAt,
            failoverCount: Math.max(0, attemptCount - 1),
            responseBodyObject: responseObject,
            responseBodyHash: responseHash.digest('hex'),
            errorCode: streamError ? 'upstream_stream_interrupted' : null,
            errorMessage: streamError?.message.slice(0, 2000) || null,
            completedAt: new Date()
          }).where(eq(requestLogs.id, log.id))
          await touchKeyCredential(event, key.id)
          await recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: parsed.model, endpoint, status: streamAborted ? 'stream_aborted' : 'success', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, affinityReused: affinityWasReused, affinityEligible: Boolean(affinityKey), totalTokens: usage.totalTokens, cost, durationMs: Date.now() - startedAt, failovers: Math.max(0, attemptCount - 1) })
          await settleAdmissions(usage.totalTokens, cost)
          if (walletHeld && walletHoldKey) { await settleUserWallet(event, userId, walletHoldKey, cost, `request:${requestId}:settle`, requestId); walletHeld = false }
          settled = true
          if (admittedChannel) {
            await releaseChannel(event, admittedChannel)
            admittedChannel = null
          }
          if (streamError) await recordChannelFailure(event, candidate.channel.id, streamError.message)
          else {
            await recordChannelSuccess(event, candidate.channel.id)
            await rememberAffinitySelection(event, affinityKey, candidate)
          }
          return
        }
        const responseChunks: Buffer[] = []
        if (response.body) {
          const reader = response.body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (firstByteMs === null) firstByteMs = Date.now() - startedAt
            responseChunks.push(Buffer.from(value))
          }
        }
        stopUpstreamTimeout()
        const responseBuffer = Buffer.concat(responseChunks)
        await closePinned()
        firstByteMs ??= Date.now() - startedAt
        const usage = extractUsage(responseBuffer, responseContentType)
        const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, parsed.model, usage, parsed.metadata, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
        const responseObject = await storeBodySafe(event, requestId, 'response', responseBuffer, responseContentType)
        if (idempotency) await completeIdempotency(event, idempotency.record.id, response.status, responseContentType, responseObject)
        await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attemptCount, status: response.ok ? 'success' : 'failed', httpStatus: response.status, durationMs: Date.now() - attemptStarted })
        await useDatabase(event).update(requestLogs).set({
          channelId: candidate.channel.id,
          protocolBindingId: candidate.protocolBinding.id,
          outboundProtocol: candidate.protocolBinding.protocol,
          conversionMode: candidate.conversionMode,
          sourceOwnerKind: candidate.channel.ownerKind,
          sourceOwnerUserId: candidate.channel.ownerUserId,
          cacheAffinityReused: affinityWasReused,
          upstreamModel: candidate.upstreamModel,
          status: response.ok ? 'success' : 'error',
          httpStatus: response.status,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          reasoningTokens: usage.reasoningTokens,
          totalTokens: usage.totalTokens,
          imageCount: usage.imageCount,
          cost: String(cost),
          billableTokens: usage.totalTokens,
          billedAmount: String(cost),
          pricingSnapshot: { model: parsed.model, channelMultiplier: Number(candidate.channel.priceMultiplier), groupMultiplier: Number(group.priceMultiplier), keyMultiplier: Number(key.priceMultiplier) },
          firstByteMs,
          durationMs: Date.now() - startedAt,
          failoverCount: Math.max(0, attemptCount - 1),
          responseBodyObject: responseObject,
          responseBodyHash: contentHash(responseBuffer),
          errorMessage: response.ok ? null : responseBuffer.toString('utf8').slice(0, 2000),
          completedAt: new Date()
        }).where(eq(requestLogs.id, log.id))
        await touchKeyCredential(event, key.id)
        await recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: parsed.model, endpoint, status: response.ok ? 'success' : 'error', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, affinityReused: affinityWasReused, affinityEligible: Boolean(affinityKey), totalTokens: usage.totalTokens, cost, durationMs: Date.now() - startedAt, failovers: Math.max(0, attemptCount - 1) })
        await settleAdmissions(usage.totalTokens, cost)
        if (walletHeld && walletHoldKey) { await settleUserWallet(event, userId, walletHoldKey, cost, `request:${requestId}:settle`, requestId); walletHeld = false }
        settled = true
        await releaseChannel(event, channelLease)
        admittedChannel = null
        if (response.ok) {
          await recordChannelSuccess(event, candidate.channel.id)
          await rememberAffinitySelection(event, affinityKey, candidate)
        }
        else if (response.status === 401 || response.status === 403 || RETRYABLE_STATUS.has(response.status)) await recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`)
        responseHeaders(event, response, requestId)
        if (!response.ok) {
          setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
          return normalizeUpstreamError(responseBuffer, response.status, response.statusText, settings.errorMessageOverrides[String(response.status)] || '')
        }
        return responseBuffer
      } catch (error) {
        stopUpstreamTimeout()
        await closePinned()
        if (responseStarted) throw error
        await useDatabase(event).insert(requestAttempts).values({
          requestLogId: log.id,
          channelId: candidate.channel.id,
          attempt: attemptCount,
          status: 'failed',
          durationMs: Date.now() - attemptStarted,
          errorMessage: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown upstream error'
        })
        await recordChannelFailure(event, candidate.channel.id, error instanceof Error ? error.message : 'upstream error')
        await releaseChannel(event, channelLease)
        admittedChannel = null
        if (endpoint.startsWith('/v1/images/')) throw error
        if (upstreamHeadersReceived) throw error
        if (index === candidates.length - 1) throw error
      }
    }
    if (packageAdmissionError && attemptCount === 0) throw packageAdmissionError
    throw new Error('All matching channels are at their concurrency limit')
  } catch (error) {
    if (idempotency) await failIdempotency(event, idempotency.record.id, upstreamRequestStarted).catch(() => {})
    if (admittedChannel) await releaseChannel(event, admittedChannel)
    if (!settled) {
      await settleHubRequest(event, key, group, 0, 0, reservation.tokens, 0, concurrencyLease)
      await releasePackageReservation()
    }
    if (walletHeld && walletHoldKey) { await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {}); walletHeld = false }
    const message = error instanceof Error ? error.message : 'All upstream channels failed'
    await useDatabase(event).update(requestLogs).set({ channelId: lastCandidate?.channel.id || null, upstreamModel: lastCandidate?.upstreamModel || null, status: 'error', httpStatus: 502, errorMessage: message.slice(0, 2000), durationMs: Date.now() - startedAt, failoverCount: Math.max(0, attemptCount - 1), completedAt: new Date() }).where(eq(requestLogs.id, log.id))
    if (lastCandidate) await recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: lastCandidate.channel.id, model: parsed.model, endpoint, status: 'error', inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, durationMs: Date.now() - startedAt, failovers: Math.max(0, attemptCount - 1) })
    if (responseStarted) return
    const failure = error as { statusCode?: number; message?: string }
    if (failure.statusCode === 429) openAiError(429, failure.message || '当前套餐额度已用尽', 'rate_limit_error', 'rate_limit_exceeded')
    openAiError(502, settings.errorMessageOverrides['502'] || message, 'server_error', 'upstream_error')
  }
}

export async function recordRejectedHubRequest(event: H3Event, path: string, error: unknown) {
  const requestId = typeof event.context.hubRequestId === 'string' ? event.context.hubRequestId : ''
  if (!requestId) return
  const db = useDatabase(event)
  const [existing] = await db.select({ id: requestLogs.id }).from(requestLogs).where(eq(requestLogs.requestId, requestId)).limit(1)
  if (existing) return

  const failure = error as { statusCode?: number; message?: string; data?: { error?: { code?: unknown; message?: unknown } } }
  const status = Number(failure.statusCode || 500)
  const endpoint = `/v1/${path.replace(/^\/+|\/+$/g, '')}`
  const keyId = typeof event.context.hubKeyId === 'string' ? event.context.hubKeyId : null
  const userId = typeof event.context.hubUserId === 'string' ? event.context.hubUserId : null
  const groupId = typeof event.context.hubGroupId === 'string' ? event.context.hubGroupId : null
  const model = typeof event.context.hubRequestedModel === 'string' ? event.context.hubRequestedModel : null
  const message = String(failure.data?.error?.message || failure.message || 'Zephyr Hub internal error').slice(0, 2000)
  const errorCode = typeof failure.data?.error?.code === 'string' ? failure.data.error.code.slice(0, 200) : null
  const startedAt = typeof event.context.hubStartedAt === 'number' ? event.context.hubStartedAt : Date.now()
  const durationMs = Math.max(0, Date.now() - startedAt)
  await db.insert(requestLogs).values({
    requestId,
    keyId,
    userId,
    groupId,
    endpoint,
    requestedModel: model,
    status: 'error',
    httpStatus: status,
    durationMs,
    errorCode,
    errorMessage: message,
    clientIpHash: hashClientIp(trustedClientIp(event), event),
    completedAt: new Date()
  })
  await recordUsageRollups(event, {
    keyId,
    userId,
    groupId,
    channelId: null,
    model,
    endpoint,
    status: 'error',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    durationMs,
    failovers: 0,
    admitted: false
  })
}
