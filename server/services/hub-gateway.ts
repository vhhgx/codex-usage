import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
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
  servicePlans,
  servicePlanVersions,
  usageRollups,
  userPoolAccounts,
  userPoolGroups,
  userRelayAccountStates,
  userRelayGroups,
  userSubscriptions,
  requestAttempts,
  requestLogs,
  users
} from '../db/schema'
import { contentHash, decryptChannelSecret, hashCacheAffinity, hashClientIp, hashHubKey } from '../utils/hub-crypto'
import { classifyRelayFailure, relayFailureAffectsAccount, relayFailureAllowsFailover } from './relay-platform'
import { MAX_UPSTREAM_RETRIES, shouldRetryUpstream, shouldRetryUpstreamError, upstreamRetryDelay, waitForUpstreamRetry } from './upstream-retry'
import { markUserRelayFailure } from './user-relays'
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
import { advanceRouteFailoverState, orderedRouteSourceNodes, packagePolicyAllowsRouteSource, recordChannelFailure, recordChannelSuccess, rememberAffinitySelection, routeCandidates, selectSupplySource, userRelayAccountAllowsRouting, type RouteFailoverState, type SupplyDecision } from './hub-routing'
import { getHubSettings } from './hub-settings'
import { recordUsageRollups } from './hub-rollups'
import { acquireIdempotency, completeIdempotency, failIdempotency } from './hub-idempotency'
import { assertTrafficAccepting } from './hub-traffic'
import { useRedis } from '../utils/redis'
import { trustedClientIp } from '../utils/client-ip'
import { copyUpstreamClientIdentity, isUpstreamClientIdentityHeader } from '../utils/upstream-client-identity'
import { pinnedUpstreamFetch, upstreamTarget } from '../utils/upstream-url'
import { effectivePriceMultiplier, policyAllows } from './group-policy'
import { getActiveSubscription } from './customer-management'
import { holdUserWallet, releaseUserWallet, settleUserWallet } from './user-wallet'
import { visibleChannels } from './channel-access'
import { getUserFailoverSourceIds } from './user-route-preferences'
import { ChatToResponsesStream, chatToResponsesResponse, responsesToChatRequest } from './protocols/responses-chat'
import { userModelRouteLanes, userRadarPreference } from './user-model-routing'
import { cachedCodexRadar, selectRadarEffort } from './codex-radar'
import { requestReasoningEffort } from '#shared/utils/request-log'
import { redactSensitivePayload, redactSensitiveText } from '../utils/upstream'

const MAX_BODY_BYTES = 50 * 1024 * 1024
const MAX_BUFFERED_BODY_BYTES = 256 * 1024 * 1024
const USAGE_TAIL_BYTES = 4 * 1024 * 1024
export const UPSTREAM_RESPONSE_LIMITS = {
  standardBytes: 64 * 1024 * 1024,
  errorBytes: 1024 * 1024,
  streamBytes: 512 * 1024 * 1024,
  streamTimeoutMs: 30 * 60 * 1000
} as const
let bufferedBodyBytes = 0

async function bestEffort(task: Promise<unknown>) {
  try {
    await task
    return true
  } catch {
    return false
  }
}

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

type UpstreamResponseLane = 'upstream' | 'output'

function upstreamResponseBudgetError(code: 'UPSTREAM_RESPONSE_TOO_LARGE' | 'UPSTREAM_STREAM_TIMEOUT', message: string) {
  const error = new Error(message)
  error.name = code === 'UPSTREAM_STREAM_TIMEOUT' ? 'TimeoutError' : 'UpstreamResponseLimitError'
  return Object.assign(error, { code, statusCode: 502 })
}

function abortUpstreamResponse(controller: AbortController, error: Error) {
  if (!controller.signal.aborted) controller.abort(error)
}

export function assertUpstreamResponseSize(bytes: number, maxBytes: number, controller: AbortController, label = 'Upstream response') {
  if (bytes <= maxBytes) return
  const error = upstreamResponseBudgetError('UPSTREAM_RESPONSE_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`)
  abortUpstreamResponse(controller, error)
  throw error
}

export function createUpstreamResponseBudget(
  controller: AbortController,
  options: { maxBytes: number; timeoutMs?: number; label?: string }
) {
  const totals: Record<UpstreamResponseLane, number> = { upstream: 0, output: 0 }
  const label = options.label || 'Upstream response'
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: Promise<never> | null = null
  if (options.timeoutMs) {
    deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        const error = upstreamResponseBudgetError('UPSTREAM_STREAM_TIMEOUT', `${label} exceeded ${options.timeoutMs} ms`)
        abortUpstreamResponse(controller, error)
        reject(error)
      }, options.timeoutMs)
      deadlineTimer.unref()
    })
    // The same deadline is raced by many chunk reads. Keep it observed even
    // during the small gaps between reads and writes.
    void deadline.catch(() => {})
  }
  const guard = async <T>(task: Promise<T>): Promise<T> => deadline ? Promise.race([task, deadline]) : task
  const accountBytes = (bytes: number, lane: UpstreamResponseLane = 'upstream') => {
    totals[lane] += Math.max(0, bytes)
    assertUpstreamResponseSize(totals[lane], options.maxBytes, controller, label)
    return totals[lane]
  }
  const account = (chunk: { byteLength: number }, lane: UpstreamResponseLane = 'upstream') => accountBytes(chunk.byteLength, lane)
  const read = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    idleTimeoutMs: number,
    lane: UpstreamResponseLane = 'upstream'
  ) => {
    try {
      const item = await guard(readUpstreamChunk(reader, idleTimeoutMs, controller))
      if (!item.done && item.value) account(item.value, lane)
      return item
    } catch (error) {
      if (controller.signal.aborted) void reader.cancel(controller.signal.reason).catch(() => {})
      throw error
    }
  }
  const finish = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    deadlineTimer = undefined
  }
  return { totals, account, accountBytes, guard, read, finish }
}

export async function readUpstreamBodyLimited(
  response: Response,
  controller: AbortController,
  maxBytes: number,
  options: { idleTimeoutMs?: number; label?: string; onChunk?: () => void } = {}
) {
  const label = options.label || 'Upstream response'
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > 0) assertUpstreamResponseSize(declared, maxBytes, controller, label)
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const budget = createUpstreamResponseBudget(controller, { maxBytes, label })
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await budget.read(reader, Math.max(1, options.idleTimeoutMs ?? 120_000))
      if (done) break
      const chunk = Buffer.from(value)
      options.onChunk?.()
      chunks.push(chunk)
      total += chunk.length
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    void reader.cancel(error).catch(() => {})
    throw error
  } finally {
    budget.finish()
  }
}

export function budgetUpstreamReadableStream(
  body: ReadableStream<Uint8Array>,
  budget: ReturnType<typeof createUpstreamResponseBudget>,
  idleTimeoutMs: number
) {
  const reader = body.getReader()
  let released = false
  const release = () => {
    if (released) return
    try {
      reader.releaseLock()
      released = true
    } catch {}
  }
  const cancelReader = (reason: unknown) => {
    try {
      void reader.cancel(reason).catch(() => {}).finally(release)
    } catch {
      release()
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(target) {
      try {
        const { done, value } = await budget.read(reader, idleTimeoutMs)
        if (done) {
          release()
          target.close()
        } else target.enqueue(value)
      } catch (error) {
        cancelReader(error)
        target.error(error)
      }
    },
    cancel(reason) {
      cancelReader(reason)
    }
  })
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

function upstreamHeaders(
  event: H3Event,
  apiKey: string,
  authScheme: 'bearer' | 'x_api_key' = 'bearer',
  apiVersion?: string | null,
  clientIdentityMode: string = 'standard'
) {
  const headers = new Headers()
  const requestHeaders = getRequestHeaders(event)
  const connectionTokens = String(requestHeaders.connection || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set([
    'authorization', 'proxy-authorization', 'x-api-key', 'host', 'content-length', 'connection', 'cookie',
    'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade', 'forwarded', 'x-forwarded-for',
    'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip', 'idempotency-key', ...connectionTokens
  ])
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!blocked.has(name.toLowerCase()) && !isUpstreamClientIdentityHeader(name) && value !== undefined) headers.set(name, String(value))
  }
  if (authScheme === 'x_api_key') {
    headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', apiVersion || '2023-06-01')
  } else headers.set('authorization', `Bearer ${apiKey}`)
  // Some compatible gateways (for example AgentRouter) reject synthetic
  // clients and require the CLI identity headers from the original request.
  // This is opt-in per channel so ordinary upstreams keep the old behavior.
  if (clientIdentityMode === 'passthrough') copyUpstreamClientIdentity(event, headers)
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
    error: { message: redactSensitiveText(override, 2000), type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: 'upstream_error' }
  }))
  try {
    const payload = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
    const error = usageRecord(payload.error)
    if (error && typeof error.message === 'string') return Buffer.from(JSON.stringify(redactSensitivePayload(payload)))
    const message = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.error === 'string' ? payload.error : statusText || `Upstream returned HTTP ${status}`
    return Buffer.from(JSON.stringify({
      error: { message: redactSensitiveText(message, 2000), type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: 'upstream_error' }
    }))
  } catch {
    const raw = redactSensitiveText(buffer.toString('utf8').trim(), 2000)
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

export function normalizeResponseForArchive(
  body: Buffer,
  response: Pick<Response, 'ok' | 'status' | 'statusText'>,
  contentType: string,
  override = ''
) {
  if (response.ok) return { body, contentType }
  return {
    body: normalizeUpstreamError(body, response.status, response.statusText, override),
    contentType: 'application/json; charset=utf-8'
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

export function reserveBodyMemory(event: H3Event, bytes: number, onCapacityExhausted: () => never = () => openAiError(503, 'Gateway request body capacity is temporarily exhausted', 'server_error', 'request_body_capacity')) {
  const reservation: BodyMemoryReservation = { bytes: 0, released: false }
  const grow = (target: number) => {
    if (reservation.released) throw timeoutError('Client connection closed while reading request body')
    const delta = Math.max(0, target - reservation.bytes)
    if (bufferedBodyBytes + delta > MAX_BUFFERED_BODY_BYTES) {
      setResponseHeader(event, 'retry-after', 1)
      onCapacityExhausted()
    }
    bufferedBodyBytes += delta
    reservation.bytes += delta
  }
  const release = () => {
    if (reservation.released) return
    reservation.released = true
    event.node.req.off('aborted', release)
    event.node.res.off('close', release)
    event.node.res.off('finish', release)
    bufferedBodyBytes = Math.max(0, bufferedBodyBytes - reservation.bytes)
  }
  event.node.req.once('aborted', release)
  event.node.res.once('close', release)
  // Keep-alive responses normally emit `finish` without closing the socket.
  // Listen to both terminal events so the reservation is returned promptly;
  // `release` is idempotent and removes the sibling listener.
  event.node.res.once('finish', release)
  if (event.node.req.aborted || event.node.req.destroyed || event.node.res.destroyed || event.node.res.writableEnded) release()
  else grow(bytes)
  return { reservation, grow, release }
}

export async function readRequestBodyLimited(
  event: H3Event,
  limit: number,
  memory: ReturnType<typeof reserveBodyMemory>,
  onTooLarge: () => never = () => openAiError(413, 'Request body exceeds 50 MB'),
  options: {
    idleTimeoutMs?: number
    totalTimeoutMs?: number
    onTimeout?: (kind: 'idle' | 'total') => never
    onAborted?: () => never
  } = {}
) {
  const chunks: Buffer[] = []
  let total = 0
  const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? 60_000)
  const totalTimeoutMs = Math.max(1, options.totalTimeoutMs ?? 300_000)
  const iterator = event.node.req[Symbol.asyncIterator]()
  let totalTimer: ReturnType<typeof setTimeout> | undefined
  let totalTimedOut = false
  const totalDeadline = new Promise<never>((_, reject) => {
    totalTimer = setTimeout(() => {
      totalTimedOut = true
      reject(timeoutError(`Request body exceeded ${totalTimeoutMs} ms`))
    }, totalTimeoutMs)
    totalTimer.unref()
  })
  const abortRequest = (): never => {
    memory.release()
    if (options.onAborted) options.onAborted()
    return openAiError(408, 'Request body was aborted', 'invalid_request_error', 'request_body_aborted')
  }
  try {
    if (event.node.req.aborted || memory.reservation.released) abortRequest()
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimedOut = false
      let item: IteratorResult<Buffer | Uint8Array | string>
      try {
        item = await Promise.race([
          iterator.next(),
          totalDeadline,
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              idleTimedOut = true
              reject(timeoutError(`Request body was idle for ${idleTimeoutMs} ms`))
            }, idleTimeoutMs)
            idleTimer.unref()
          })
        ])
      } catch (error) {
        if (!idleTimedOut && !totalTimedOut) {
          if (event.node.req.aborted || memory.reservation.released) abortRequest()
          throw error
        }
        event.node.req.resume()
        const kind = totalTimedOut ? 'total' : 'idle'
        if (options.onTimeout) options.onTimeout(kind)
        openAiError(408, 'Request body timed out', 'invalid_request_error', 'request_body_timeout')
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
      if (item.done) break
      const value = item.value
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      total += chunk.length
      if (total > limit) {
        event.node.req.resume()
        onTooLarge()
      }
      memory.grow(total)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
  } finally {
    if (totalTimer) clearTimeout(totalTimer)
  }
}

export async function listAccessibleModels(event: H3Event, key: typeof hubKeys.$inferSelect, group: typeof groups.$inferSelect, userId: string, protocols: Array<'anthropic_messages' | 'openai_responses' | 'openai_chat'>) {
  const db = useDatabase(event)
  const [rules, groupRules, channelRules] = await Promise.all([
    db.select().from(keyModelRules).where(eq(keyModelRules.keyId, key.id)),
    db.select().from(groupModelRules).where(eq(groupModelRules.groupId, group.id)),
    db.select().from(groupChannelRules).where(eq(groupChannelRules.groupId, group.id))
  ])
  const rows = await db.select({
    publicModel: channelModels.publicModel,
    channelId: channels.id,
    channelType: channels.type,
    ownerKind: channels.ownerKind,
    clientIdentityMode: channels.clientIdentityMode,
    healthStatus: channels.healthStatus,
    protocol: channelProtocolBindings.protocol,
    verificationStatus: channelProtocolBindings.verificationStatus,
    routingState: userRelayAccountStates.routingState,
    relayGroupEnabled: userRelayGroups.enabled
  })
    .from(channelModelBindings)
    .innerJoin(channelModels, eq(channelModelBindings.channelModelId, channelModels.id))
    .innerJoin(channelProtocolBindings, eq(channelModelBindings.protocolBindingId, channelProtocolBindings.id))
    .innerJoin(channels, eq(channelModels.channelId, channels.id))
    .leftJoin(userRelayAccountStates, eq(channels.id, userRelayAccountStates.channelId))
    .leftJoin(userRelayGroups, eq(channels.userRelayGroupId, userRelayGroups.id))
    .where(and(eq(channelModels.enabled, true), eq(channelModelBindings.enabled, true), eq(channelProtocolBindings.enabled, true), eq(channels.enabled, true)))
  const pools = await db.select().from(modelPools)
  const disabledPools = new Set(pools.filter(pool => !pool.enabled).map(pool => pool.publicModel))
  const redis = useRedis(event)
  const visibleIds = new Set((await visibleChannels(event, userId, key.id)).map(channel => channel.id))
  const [activeSubscription, [privatePool]] = await Promise.all([
    getActiveSubscription(event, userId),
    db.select({ id: userPoolGroups.id }).from(userPoolGroups).where(and(eq(userPoolGroups.ownerUserId, userId), eq(userPoolGroups.status, 'active'))).limit(1)
  ])
  const privatePoolAvailable = Boolean(privatePool && (await db.select({ id: userPoolAccounts.id })
    .from(userPoolAccounts)
    .where(and(
      eq(userPoolAccounts.poolGroupId, privatePool.id),
      eq(userPoolAccounts.status, 'active'),
      eq(userPoolAccounts.schedulable, true)
    ))
    .limit(1))[0])
  const usableRows = []
  const restrictedChannels = channelRules.length > 0
  const enabledChannels = new Set(channelRules.filter(rule => rule.enabled).map(rule => rule.channelId))
  for (const row of rows) {
    const routable = (row.healthStatus === 'healthy' || row.ownerKind === 'user' && row.healthStatus === 'unknown' || row.ownerKind === 'platform' && row.healthStatus === 'unknown' && row.clientIdentityMode === 'passthrough')
      && row.verificationStatus !== 'failed'
      && (row.ownerKind !== 'user' || !row.routingState || row.routingState === 'active')
    const privatePoolEligible = key.routeMode !== 'platform_only'
      && row.ownerKind === 'platform'
      && row.channelType === 'sub2api'
      && privatePoolAvailable
    const sourceAvailable = row.ownerKind === 'user'
      || Boolean(activeSubscription)
      || privatePoolEligible
    const channelVisible = visibleIds.has(row.channelId) || privatePoolEligible
    if (!sourceAvailable || !protocols.includes(row.protocol) || !channelVisible || !routable || row.relayGroupEnabled === false || disabledPools.has(row.publicModel)) continue
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
  let concurrencyLease: HubConcurrencyLease | null = null
  try {
    concurrencyLease = await admitHubRequest(event, key, group, 0, 0, { scopeMode: 'base_only' })
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
    await bestEffort(useDatabase(event).update(requestLogs).set({
      status: 'success',
      httpStatus: 200,
      firstByteMs: durationMs,
      durationMs,
      completedAt: new Date()
    }).where(eq(requestLogs.id, log.id)))
    await bestEffort(touchKeyCredential(event, key.id))
    await bestEffort(recordUsageRollups(event, {
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
    }))
    return result
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const message = redactSensitiveText(error instanceof Error ? error.message : 'Unable to list models', 2000)
    if (log) {
      await bestEffort(useDatabase(event).update(requestLogs).set({
        status: 'error',
        httpStatus: 500,
        durationMs,
        errorMessage: redactSensitiveText(message, 2000),
        completedAt: new Date()
      }).where(eq(requestLogs.id, log.id)))
      await bestEffort(recordUsageRollups(event, {
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
      }))
    }
    throw error
  } finally {
    if (concurrencyLease) await settleHubRequest(event, key, group, 0, 0, 0, 0, concurrencyLease).catch(() => {})
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
  const requestedReasoningEffort = requestReasoningEffort(parsed.json)
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
      reasoningEffort: requestedReasoningEffort,
      inboundProtocol: endpoint === '/v1/responses' ? 'openai_responses' : 'openai_chat',
      status: replay.status >= 200 && replay.status < 400 ? 'success' : 'error',
      httpStatus: replay.status,
      errorCode: 'idempotent_replay',
      durationMs: 0,
      completedAt: now
    })
    await bestEffort(recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: null, model: parsed.model, endpoint, status: replay.status >= 200 && replay.status < 400 ? 'success' : 'error', inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, durationMs: 0, failovers: 0, admitted: false }))
    await bestEffort(touchKeyCredential(event, key.id))
    setResponseStatus(event, replay.status)
    setResponseHeader(event, 'content-type', replay.contentType)
    setResponseHeader(event, 'x-idempotent-replayed', 'true')
    return replay.status >= 400 ? normalizeUpstreamError(replay.body, replay.status, '', (await getHubSettings(event)).errorMessageOverrides[String(replay.status)] || '') : replay.body
  }
  let candidates: Awaited<ReturnType<typeof routeCandidates>>
  let supplyDecision: SupplyDecision = { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
  let packageDecision: SupplyDecision | null = null
  let privatePool: typeof userPoolGroups.$inferSelect | undefined
  let packageSupplyMode = 'platform_only'
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
    const modelLanes = await userModelRouteLanes(event, userId, parsed.model)
    ;[privatePool] = await useDatabase(event).select().from(userPoolGroups).where(and(eq(userPoolGroups.ownerUserId, userId), eq(userPoolGroups.status, 'active'))).limit(1)
    const privatePoolAvailable = Boolean(privatePool && (await useDatabase(event).select({ id: userPoolAccounts.id }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, privatePool.id), eq(userPoolAccounts.status, 'active'), eq(userPoolAccounts.schedulable, true))).limit(1))[0])
    const candidateBatches: Array<{ node: ReturnType<typeof orderedRouteSourceNodes>[number]; candidates: Awaited<ReturnType<typeof routeCandidates>> }> = []
    for (const lane of modelLanes) {
      const laneSourceIds = [...lane.orderedSourceIds.filter(id => sourceIds.includes(id)), ...sourceIds.filter(id => !lane.orderedSourceIds.includes(id))]
      const sourceNodes = orderedRouteSourceNodes(key.routeMode, laneSourceIds)
      const laneBatches = await Promise.all(sourceNodes.map(async node => {
        const laneOptions = { ...routeOptions, requestedModel: parsed.model, substitution: lane.substitution, orderMode: lane.orderMode }
        return {
          node,
          candidates: node.source === 'platform'
            ? await routeCandidates(event, lane.actualModel, endpoint, group.id, 'platform', undefined, laneOptions)
            : node.source === 'private_pool'
              ? privatePoolAvailable ? await routeCandidates(event, lane.actualModel, endpoint, group.id, 'private_pool', privatePool!.id, laneOptions) : []
              : await routeCandidates(event, lane.actualModel, endpoint, group.id, 'user_relay', undefined, { ...laneOptions, channelId: node.channelId, relayGroupId: node.relayGroupId })
        }
      }))
      candidateBatches.push(...laneBatches)
    }
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
    const activeSubscription = hasPackageNode ? await getActiveSubscription(event, userId) : null
    if (hasPackageNode && activeSubscription) {
      const version = activeSubscription.subscription.planVersionId
        ? (await useDatabase(event).select().from(servicePlanVersions).where(eq(servicePlanVersions.id, activeSubscription.subscription.planVersionId)).limit(1))[0]
        : null
      const snapshot = activeSubscription.subscription.entitlementSnapshot || {}
      packageBillingMode = String(version?.billingMode || snapshot.billingMode || (activeSubscription.plan.mode === 'token' ? 'token_package' : activeSubscription.plan.mode === 'cost' ? 'token_metered' : 'unlimited'))
      const supplyMode = String(version?.supplyMode || snapshot.supplyMode || 'platform_only')
      packageSupplyMode = supplyMode
      const tokenLimit = Number(version?.tokenLimit ?? snapshot.tokenLimit ?? activeSubscription.plan.tokenLimit ?? 0)
      const usedRow = tokenLimit > 0
        ? (await useDatabase(event).select({ tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)` }).from(usageRollups).where(and(
            eq(usageRollups.userId, userId),
            eq(usageRollups.granularity, 'day'),
            gte(usageRollups.bucketStart, activeSubscription.subscription.startsAt),
            eq(usageRollups.supplySource, 'platform')
          )))[0]
        : null
      try {
        packageDecision = selectSupplySource({
          billingMode: packageBillingMode,
          supplyMode,
          estimatedTokens: reservation.tokens,
          remainingTokens: tokenLimit > 0 ? Math.max(0, tokenLimit - Number(usedRow?.tokens || 0)) : null,
          privatePoolAvailable,
          subscriptionId: activeSubscription.subscription.id,
          planVersionId: version?.id || activeSubscription.subscription.planVersionId,
          poolGroupId: privatePool?.id
        })
      } catch (error) {
        const hasRelayCandidates = candidateBatches.some(batch => batch.node.source === 'user_relay' && batch.candidates.length)
        if (!hasRelayCandidates) throw error
      }
    }
    const orderedCandidates: typeof initialCandidates = []
    // candidateBatches already follows the user's saved source order. Keep
    // that order intact instead of putting every private relay ahead of the
    // package/platform node.
    for (const batch of candidateBatches) {
      if (!packagePolicyAllowsRouteSource(batch.node.source, {
        hasActiveSubscription: Boolean(activeSubscription),
        packageSupplyMode,
        packageDecisionSource: packageDecision?.source || null
      })) continue
      orderedCandidates.push(...batch.candidates)
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
  // Keep the base admission state available from the moment Redis admits the
  // request. Every setup failure below must be able to settle it exactly once.
  let baseAdmissionSettled = false
  const settleBaseAdmission = async (totalTokens = 0, cost = 0) => {
    if (baseAdmissionSettled) return true
    const settled = await bestEffort(settleHubRequest(event, key, group, totalTokens, cost, reservation.tokens, 0, concurrencyLease))
    if (settled) baseAdmissionSettled = true
    return settled
  }
  const startedAt = Date.now()
  const { settings, relayGroupNames, packagePlan } = await (async () => {
    const settings = await getHubSettings(event)
    const relayGroupIds = [...new Set(candidates.map(candidate => candidate.relayGroupId).filter((value): value is string => Boolean(value)))]
    const relayGroupRows = relayGroupIds.length ? await useDatabase(event).select({ id: userRelayGroups.id, name: userRelayGroups.name }).from(userRelayGroups).where(inArray(userRelayGroups.id, relayGroupIds)) : []
    const relayGroupNames = new Map(relayGroupRows.map(row => [row.id, row.name]))
    const packageSubscriptionId = packageDecision?.source === 'platform' ? packageDecision.subscriptionId : null
    const [packagePlan] = packageSubscriptionId
      ? await useDatabase(event).select({ name: servicePlans.name }).from(userSubscriptions).innerJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id)).where(eq(userSubscriptions.id, packageSubscriptionId)).limit(1)
      : []
    return { settings, relayGroupNames, packagePlan }
  })().catch(async error => {
    // The base lease is already admitted at this point. Any setup failure
    // must release it before the error reaches the client.
    if (concurrencyLease) await settleBaseAdmission()
    if (idempotency) await failIdempotency(event, idempotency.record.id, false).catch(() => {})
    throw error
  })
  const decisionForCandidate = (candidate: typeof candidates[number]): SupplyDecision => {
    if (candidate.supplySource === 'user_relay') return { source: 'user_relay', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    if (candidate.supplySource === 'private_pool') return { source: 'private_pool', subscriptionId: null, planVersionId: null, reservedTokens: 0, poolGroupId: privatePool?.id }
    return packageDecision?.source === 'platform'
      ? packageDecision
      : { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
  }
  const resourceFields = (candidate: typeof candidates[number]) => {
    const resourceType = candidate.supplySource === 'user_relay' ? 'user_relay' as const : candidate.supplySource === 'private_pool' ? 'private_pool' as const : 'subscription' as const
    const candidateDecision = decisionForCandidate(candidate)
    const resourceId = candidate.supplySource === 'user_relay' ? candidate.relayGroupId || candidate.channel.id : candidate.supplySource === 'private_pool' ? candidateDecision.poolGroupId || null : candidateDecision.subscriptionId
    const resourceName = candidate.supplySource === 'user_relay' ? relayGroupNames.get(candidate.relayGroupId || '') || candidate.channel.name : candidate.supplySource === 'private_pool' ? privatePool?.displayName || '我的专属号池' : packagePlan?.name || '当前套餐'
    return { resourceType, resourceId, resourceNameSnapshot: resourceName, executionNameSnapshot: candidate.channel.accountLabel || candidate.channel.name, userRelayGroupId: candidate.relayGroupId || null }
  }
  const initialResource = resourceFields(candidates[0]!)
  let log: typeof requestLogs.$inferSelect | undefined
  try {
    [log] = await useDatabase(event).insert(requestLogs).values({
      requestId,
      keyId: key.id,
      userId,
      groupId: group.id,
      endpoint,
      requestedModel: parsed.model,
      reasoningEffort: requestedReasoningEffort,
      inboundProtocol: endpoint === '/v1/responses' ? 'openai_responses' : 'openai_chat',
      status: 'pending',
      streaming,
      supplySource: supplyDecision.source,
      ...initialResource,
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
    await settleBaseAdmission()
    await releasePackageReservation()
    if (idempotency) await failIdempotency(event, idempotency.record.id, false).catch(() => {})
    throw error
  }
  if (!log) {
    await settleBaseAdmission()
    await releasePackageReservation()
    throw createError({ statusCode: 500, message: 'Unable to initialize request log' })
  }
  try {
    const requestObject = await storeBodySafe(event, requestId, 'request', archivedRequestBody, contentType)
    if (requestObject) await useDatabase(event).update(requestLogs).set({ requestBodyObject: requestObject }).where(eq(requestLogs.id, log.id))
  } catch (error) {
    await settleBaseAdmission()
    await releasePackageReservation()
    if (idempotency) await failIdempotency(event, idempotency.record.id, false).catch(() => {})
    throw error
  }

  let admittedChannel: ChannelConcurrencyLease | null = null
  let lastCandidate: typeof candidates[number] | null = null
  let attemptCount = 0
  let routeFailoverState: RouteFailoverState = { candidateKey: null, count: 0 }
  let settled = false
  let responseStarted = false
  let upstreamRequestStarted = false
  let packageAdmissionError: unknown = null
  let effectiveReasoningEffort = requestedReasoningEffort
  // A wallet settlement uses a different idempotency key from a release. If
  // the database call times out after committing, retain the intended amount
  // and retry settlement instead of issuing a potentially conflicting release.
  let walletSettlementCost: number | null = null

  // Keep a lease handle until Redis confirms the release.  Clearing the
  // handle after a failed network call makes the outer cleanup unable to
  // retry and can leave a channel permanently occupied until its TTL.
  const releaseTrackedChannel = async (lease: ChannelConcurrencyLease) => {
    const released = await bestEffort(releaseChannel(event, lease))
    if (released && admittedChannel === lease) admittedChannel = null
    return released
  }

  const settleWalletReservation = async (cost: number) => {
    if (!walletHeld || !walletHoldKey) return true
    walletSettlementCost = cost
    const settled = await bestEffort(settleUserWallet(event, userId, walletHoldKey, cost, `request:${requestId}:settle`, requestId))
    if (settled) {
      walletHeld = false
      walletSettlementCost = null
    }
    return settled
  }

  async function releasePackageReservation() {
    let released = true
    if (packageAdmissionLease) {
      const lease = packageAdmissionLease
      if (await bestEffort(cancelHubAdmission(event, lease, reservation.tokens, reservation.cost))) packageAdmissionLease = null
      else released = false
    }
    if (walletHeld && walletHoldKey && walletSettlementCost === null) {
      if (await bestEffort(releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId))) walletHeld = false
      else released = false
    }
    return released
  }

  async function activateCandidateSupply(candidate: typeof candidates[number]) {
    const nextDecision = decisionForCandidate(candidate)
    if (nextDecision.source === 'user_relay' || nextDecision.source === 'private_pool') {
      if (!await releasePackageReservation()) throw new Error('无法释放套餐预留')
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
        if (!await releasePackageReservation()) throw new Error('无法释放套餐预留')
        return false
      }
    }
    supplyDecision = nextDecision
    event.context.hubSupplySource = supplyDecision.source
    event.context.hubPoolGroupId = supplyDecision.poolGroupId
    event.context.hubSubscriptionId = supplyDecision.subscriptionId
    event.context.hubPlanVersionId = supplyDecision.planVersionId
    await bestEffort(useDatabase(event).update(requestLogs).set({
      supplySource: supplyDecision.source,
      poolGroupId: supplyDecision.poolGroupId || null,
      subscriptionId: supplyDecision.subscriptionId,
      planVersionId: supplyDecision.planVersionId,
      billedAmount: String(supplyDecision.source === 'user_relay' ? 0 : reservation.cost),
      ...resourceFields(candidate)
    }).where(eq(requestLogs.id, log!.id)))
    return true
  }

  async function settleAdmissions(totalTokens: number, cost: number) {
    if (!baseAdmissionSettled) {
      await settleHubRequest(event, key, group, totalTokens, cost, reservation.tokens, 0, concurrencyLease)
      baseAdmissionSettled = true
    }
    if (packageAdmissionLease) {
      if (supplyDecision.source !== 'platform') throw new Error('私有来源仍存在套餐预留')
      const lease = packageAdmissionLease
      await settleHubRequest(event, key, group, totalTokens, cost, reservation.tokens, reservation.cost, lease)
      packageAdmissionLease = null
    }
  }

  try {
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!
      if (candidate.channel.ownerKind === 'user' && !await userRelayAccountAllowsRouting(event, candidate.channel.id)) continue
      const channelLease = await acquireChannel(event, candidate.channel.id, candidate.channel.maxConcurrency, candidate.relayGroupId ? { id: candidate.relayGroupId, max: candidate.relayGroupMaxConcurrency || null } : undefined)
      if (!channelLease) continue
      admittedChannel = channelLease
      let activated = false
      try {
        activated = await activateCandidateSupply(candidate)
      } catch (error) {
        // The channel slot is acquired before supply activation. Keep the
        // handle tracked so an outer cleanup can retry a failed Redis call.
        if (!await releaseTrackedChannel(channelLease)) throw new Error('无法释放渠道并发租约')
        throw error
      }
      if (!activated) {
        if (!await releaseTrackedChannel(channelLease)) throw new Error('无法释放渠道并发租约')
        continue
      }
      routeFailoverState = advanceRouteFailoverState(routeFailoverState, candidate)
      affinityWasReused = candidate.affinityReused === true
      lastCandidate = candidate
      let attemptStarted = Date.now()
      let upstreamHeadersReceived = false
      let candidateRequestStarted = false
      let closePinnedConnection: (() => Promise<void>) | null = null
      let streamDirectory: string | null = null
      let streamArchive: ReturnType<typeof createWriteStream> | null = null
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
        const upstreamEndpoint = candidate.conversionMode === 'responses_to_chat' ? '/v1/chat/completions' : endpoint
        if (parsed.json) {
          let requestJson: Record<string, unknown> = parsed.json
          if (endpoint === '/v1/responses' && !candidate.laneSubstitution && candidate.modelMappingKind !== 'substitution') {
            const preference = await userRadarPreference(event, userId)
            if (preference.enabled) {
              try {
                const effort = selectRadarEffort(await cachedCodexRadar(event), parsed.model, preference.maxEffort)
                if (effort) requestJson = { ...requestJson, reasoning: { ...(usageRecord(requestJson.reasoning) || {}), effort } }
              } catch { /* Preserve the client effort when CodexRadar is unavailable. */ }
            }
          }
          effectiveReasoningEffort = requestReasoningEffort(requestJson)
          const payload: Record<string, unknown> = candidate.conversionMode === 'responses_to_chat'
            ? responsesToChatRequest(requestJson, candidate.upstreamModel)
            : { ...requestJson, model: candidate.upstreamModel }
          if (streaming && upstreamEndpoint === '/v1/chat/completions') {
            payload.stream_options = { ...(usageRecord(payload.stream_options) || {}), include_usage: true }
          }
          outgoing = Buffer.from(JSON.stringify(payload))
        } else if (contentType.includes('multipart/form-data')) {
          outgoing = replaceMultipartModel(requestBody, contentType, candidate.upstreamModel)
        }
        const upstreamBase = candidate.protocolBinding.baseUrlOverride || candidate.channel.baseUrl
        const credential = candidate.credential || decryptChannelSecret(candidate.channel.encryptedApiKey, candidate.channel.id, candidate.channel.ownerKind, event)
        const headers = upstreamHeaders(event, credential, candidate.protocolBinding.authScheme, candidate.protocolBinding.apiVersion, candidate.channel.clientIdentityMode)
        upstreamRequestStarted = true
        candidateRequestStarted = true
        let response: Response
        let prefetchedResponseBuffer: Buffer | null = null
        let responseFailureClass = null as ReturnType<typeof classifyRelayFailure> | null
        for (let retryIndex = 0; ; retryIndex++) {
          attemptCount += 1
          attemptStarted = Date.now()
          upstreamHeadersReceived = false
          try {
            response = candidate.channel.ownerKind === 'user'
              ? await (async () => {
                  const result = await pinnedUpstreamFetch(upstreamBase, upstreamEndpoint, { method: 'POST', headers, body: outgoing, signal: upstreamAbort.signal })
                  closePinnedConnection = result.close
                  return result.response as unknown as Response
                })()
              : await fetch(upstreamTarget(upstreamBase, upstreamEndpoint), { method: 'POST', headers, body: outgoing as unknown as BodyInit, redirect: 'manual', signal: upstreamAbort.signal })
          } catch (error) {
            if (retryIndex >= MAX_UPSTREAM_RETRIES || upstreamAbort.signal.aborted || !shouldRetryUpstreamError(error)) throw error
            await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attemptCount, status: 'retrying', durationMs: Date.now() - attemptStarted, errorMessage: redactSensitiveText(error instanceof Error ? error.message : 'Temporary upstream network error', 2000), failureClass: 'upstream_unavailable', ...resourceFields(candidate) }))
            await closePinned()
            closePinnedConnection = null
            await waitForUpstreamRetry(upstreamRetryDelay(null, retryIndex))
            continue
          }
          upstreamHeadersReceived = true
          prefetchedResponseBuffer = null
          responseFailureClass = null
          if (!response.ok) {
            prefetchedResponseBuffer = await readUpstreamBodyLimited(response, upstreamAbort, UPSTREAM_RESPONSE_LIMITS.errorBytes, {
              idleTimeoutMs: candidate.channel.timeoutMs,
              label: 'Upstream error response'
            })
            responseFailureClass = classifyRelayFailure(response.status, prefetchedResponseBuffer.toString('utf8'))
          }
          const failureText = prefetchedResponseBuffer?.toString('utf8') || ''
          if (!shouldRetryUpstream(response.status, failureText) || retryIndex >= MAX_UPSTREAM_RETRIES) break
          await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attemptCount, status: 'retrying', httpStatus: response.status, durationMs: Date.now() - attemptStarted, errorMessage: redactSensitiveText(failureText, 2000), failureClass: responseFailureClass || 'upstream_unavailable', ...resourceFields(candidate) }))
          await closePinned()
          closePinnedConnection = null
          await waitForUpstreamRetry(upstreamRetryDelay(response.headers.get('retry-after'), retryIndex))
        }
        const retryable = responseFailureClass
          ? relayFailureAllowsFailover(response.status, responseFailureClass, candidate.channel.ownerKind === 'user')
          : false
        if (retryable && index < candidates.length - 1) {
          const errorText = redactSensitiveText(prefetchedResponseBuffer!.toString('utf8'), 1000)
          await closePinned()
          stopUpstreamTimeout()
          await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attemptCount, status: 'failed', httpStatus: response.status, durationMs: Date.now() - attemptStarted, errorMessage: errorText, failureClass: responseFailureClass, ...resourceFields(candidate) }))
          if (candidate.channel.ownerKind === 'user') await bestEffort(markUserRelayFailure(event, candidate.channel.id, responseFailureClass!, errorText))
          if (relayFailureAffectsAccount(responseFailureClass!)) await bestEffort(recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`))
          if (!await releaseTrackedChannel(channelLease)) throw new Error('无法释放渠道并发租约')
          continue
        }

        let firstByteMs: number | null = null
        const responseContentType = response.headers.get('content-type') || 'application/octet-stream'
        if (streaming && response.ok && response.body) {
          const declaredStreamBytes = Number(response.headers.get('content-length'))
          if (Number.isFinite(declaredStreamBytes) && declaredStreamBytes > 0) {
            assertUpstreamResponseSize(
              declaredStreamBytes,
              UPSTREAM_RESPONSE_LIMITS.streamBytes,
              upstreamAbort,
              'Upstream streaming response'
            )
          }
          stopUpstreamTimeout()
          responseStarted = true
          responseHeaders(event, response, requestId)
          if (candidate.conversionMode === 'responses_to_chat') setResponseHeader(event, 'content-type', 'text/event-stream; charset=utf-8')
          const temporaryDirectory = await mkdtemp(join(tmpdir(), 'zephyr-hub-response-'))
          streamDirectory = temporaryDirectory
          const temporaryPath = join(temporaryDirectory, 'body')
          const archive = createWriteStream(temporaryPath, { flags: 'wx' })
          streamArchive = archive
          const responseHash = createHash('sha256')
          let usageTail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
          const responseConverter = candidate.conversionMode === 'responses_to_chat' ? new ChatToResponsesStream(parsed.model) : null
          const reader = response.body.getReader()
          const streamBudget = createUpstreamResponseBudget(upstreamAbort, {
            maxBytes: UPSTREAM_RESPONSE_LIMITS.streamBytes,
            timeoutMs: UPSTREAM_RESPONSE_LIMITS.streamTimeoutMs,
            label: 'Upstream streaming response'
          })
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
              const { done, value } = await streamBudget.read(reader, candidate.channel.timeoutMs)
              if (done) break
              const chunk = Buffer.from(value)
              if (firstByteMs === null) firstByteMs = Date.now() - startedAt
              usageTail = appendUsageTail(usageTail, chunk)
              const clientChunk = responseConverter ? responseConverter.push(chunk) : chunk
              streamBudget.account(clientChunk, 'output')
              responseHash.update(clientChunk)
              if (clientChunk.length && !archive.write(clientChunk)) await streamBudget.guard(once(archive, 'drain'))
              if (clientChunk.length && !clientAborted && !await streamBudget.guard(writeResponseChunk(event.node.res, clientChunk))) {
                markAborted()
                break
              }
              await streamBudget.guard(Promise.all([
                renewHubConcurrency(event, concurrencyLease),
                ...(packageAdmissionLease ? [renewHubConcurrency(event, packageAdmissionLease)] : []),
                renewChannel(event, channelLease)
              ]))
            }
            if (responseConverter && !clientAborted) {
              const finalChunk = responseConverter.push(Buffer.alloc(0), true)
              streamBudget.account(finalChunk, 'output')
              responseHash.update(finalChunk)
              if (finalChunk.length && !archive.write(finalChunk)) await streamBudget.guard(once(archive, 'drain'))
              if (finalChunk.length) await streamBudget.guard(writeResponseChunk(event.node.res, finalChunk))
            }
          } catch (error) {
            if (!clientAborted) streamError = error instanceof Error ? error : new Error('Upstream stream was interrupted')
          } finally {
            event.node.res.off('close', markAborted)
            try {
              const archiveFinished = once(archive, 'finish')
              archive.end()
              await streamBudget.guard(archiveFinished)
            } catch (error) {
              if (!clientAborted && !streamError) streamError = error instanceof Error ? error : new Error('Unable to finalize upstream stream')
            } finally {
              streamBudget.finish()
              await closePinned()
              try {
                await releaseHubConcurrency(event, concurrencyLease)
              } catch {}
              await releaseTrackedChannel(channelLease)
              if (streamError && !clientAborted && !event.node.res.destroyed && !event.node.res.writableEnded) {
                const failureCode = String((streamError as Error & { code?: string }).code || 'UPSTREAM_STREAM_INTERRUPTED')
                const failureMessage = failureCode === 'UPSTREAM_RESPONSE_TOO_LARGE'
                  ? 'Upstream streaming response exceeded the gateway size limit'
                  : failureCode === 'UPSTREAM_STREAM_TIMEOUT'
                    ? 'Upstream streaming response exceeded the gateway time limit'
                    : 'Upstream streaming response was interrupted'
                const failureEvent = endpoint === '/v1/responses'
                  ? { type: 'error', code: 'server_error', message: failureMessage, param: null }
                  : { error: { message: failureMessage, type: 'server_error', param: null, code: 'upstream_stream_error' } }
                try {
                  event.node.res.write(Buffer.from(`event: error\ndata: ${JSON.stringify(failureEvent)}\n\n`))
                } catch {}
              }
              if (!event.node.res.writableEnded) event.node.res.end()
            }
          }
          const usage = extractUsage(usageTail, responseContentType)
          const streamAborted = clientAborted || Boolean(streamError)
          const streamHttpStatus = streamError ? 502 : response.status
          const streamErrorCode = streamError
            ? String((streamError as Error & { code?: string }).code || 'UPSTREAM_STREAM_INTERRUPTED')
            : null
          const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, parsed.model, usage, parsed.metadata, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
          const storedResponseContentType = candidate.conversionMode === 'responses_to_chat' ? 'text/event-stream; charset=utf-8' : responseContentType
          const responseObject = await storeFileSafe(event, requestId, 'response', temporaryPath, storedResponseContentType)
          await bestEffort(useDatabase(event).insert(requestAttempts).values({
            requestLogId: log.id,
            channelId: candidate.channel.id,
            protocolBindingId: candidate.protocolBinding.id,
            attempt: attemptCount,
            status: streamAborted ? 'stream_aborted' : 'success',
            httpStatus: streamHttpStatus,
            durationMs: Date.now() - attemptStarted,
            errorMessage: streamError ? redactSensitiveText(streamError.message, 2000) : null,
            ...resourceFields(candidate)
          }))
          await bestEffort(useDatabase(event).update(requestLogs).set({
            channelId: candidate.channel.id,
            protocolBindingId: candidate.protocolBinding.id,
            outboundProtocol: candidate.protocolBinding.protocol,
            conversionMode: candidate.conversionMode,
            sourceOwnerKind: candidate.channel.ownerKind,
            sourceOwnerUserId: candidate.channel.ownerUserId,
            ...resourceFields(candidate),
            cacheAffinityReused: affinityWasReused,
            upstreamModel: candidate.upstreamModel,
            reasoningEffort: effectiveReasoningEffort,
            status: streamAborted ? 'stream_aborted' : 'success',
            httpStatus: streamHttpStatus,
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
            failoverCount: routeFailoverState.count,
            responseBodyObject: responseObject,
            responseBodyHash: responseHash.digest('hex'),
            errorCode: streamErrorCode,
            errorMessage: streamError ? redactSensitiveText(streamError.message, 2000) : null,
            completedAt: new Date()
          }).where(eq(requestLogs.id, log.id)))
          await bestEffort(touchKeyCredential(event, key.id))
          await bestEffort(recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: parsed.model, endpoint, status: streamAborted ? 'stream_aborted' : 'success', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, affinityReused: affinityWasReused, affinityEligible: Boolean(affinityKey), totalTokens: usage.totalTokens, cost, durationMs: Date.now() - startedAt, failovers: routeFailoverState.count }))
          await settleAdmissions(usage.totalTokens, cost)
          // Finalize Redis admissions before wallet/telemetry work so a
          // downstream failure cannot trigger a second settlement.
          settled = true
          if (!await settleWalletReservation(cost)) throw new Error('钱包结算失败')
          if (admittedChannel && !await releaseTrackedChannel(admittedChannel)) throw new Error('无法释放渠道并发租约')
          if (streamError) await bestEffort(recordChannelFailure(event, candidate.channel.id, streamError.message))
          else {
            await bestEffort(recordChannelSuccess(event, candidate.channel.id, candidate.channel.ownerKind === 'user' ? candidate.protocolBinding.id : undefined))
            await bestEffort(rememberAffinitySelection(event, affinityKey, candidate))
          }
          return
        }
        const upstreamResponseBuffer = prefetchedResponseBuffer || await readUpstreamBodyLimited(
          response,
          upstreamAbort,
          response.ok ? UPSTREAM_RESPONSE_LIMITS.standardBytes : UPSTREAM_RESPONSE_LIMITS.errorBytes,
          {
            idleTimeoutMs: candidate.channel.timeoutMs,
            label: response.ok ? 'Upstream response' : 'Upstream error response',
            onChunk: () => { firstByteMs ??= Date.now() - startedAt }
          }
        )
        stopUpstreamTimeout()
        await closePinned()
        firstByteMs ??= Date.now() - startedAt
        const usage = extractUsage(upstreamResponseBuffer, responseContentType)
        let responseBuffer: Buffer<ArrayBufferLike> = upstreamResponseBuffer
        let clientResponseContentType = responseContentType
        if (response.ok && candidate.conversionMode === 'responses_to_chat') {
          let payload: Record<string, unknown>
          try { payload = JSON.parse(upstreamResponseBuffer.toString('utf8')) } catch { throw createError({ statusCode: 502, message: 'Chat 上游未返回可转换的 JSON 响应' }) }
          responseBuffer = Buffer.from(JSON.stringify(chatToResponsesResponse(payload, parsed.model)))
          clientResponseContentType = 'application/json; charset=utf-8'
        }
        const archivableResponse = normalizeResponseForArchive(responseBuffer, response, clientResponseContentType, settings.errorMessageOverrides[String(response.status)] || '')
        responseBuffer = archivableResponse.body
        clientResponseContentType = archivableResponse.contentType
        assertUpstreamResponseSize(
          responseBuffer.length,
          response.ok ? UPSTREAM_RESPONSE_LIMITS.standardBytes : UPSTREAM_RESPONSE_LIMITS.errorBytes,
          upstreamAbort,
          response.ok ? 'Upstream response' : 'Upstream error response'
        )
        const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, parsed.model, usage, parsed.metadata, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
        const responseObject = await storeBodySafe(event, requestId, 'response', responseBuffer, clientResponseContentType)
        if (idempotency) await bestEffort(completeIdempotency(event, idempotency.record.id, response.status, clientResponseContentType, responseObject))
        await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attemptCount, status: response.ok ? 'success' : 'failed', httpStatus: response.status, durationMs: Date.now() - attemptStarted, failureClass: response.ok ? null : classifyRelayFailure(response.status, upstreamResponseBuffer.toString('utf8')), ...resourceFields(candidate) }))
        await bestEffort(useDatabase(event).update(requestLogs).set({
          channelId: candidate.channel.id,
          protocolBindingId: candidate.protocolBinding.id,
          outboundProtocol: candidate.protocolBinding.protocol,
          conversionMode: candidate.conversionMode,
          sourceOwnerKind: candidate.channel.ownerKind,
          sourceOwnerUserId: candidate.channel.ownerUserId,
          ...resourceFields(candidate),
          cacheAffinityReused: affinityWasReused,
          upstreamModel: candidate.upstreamModel,
          reasoningEffort: effectiveReasoningEffort,
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
          failoverCount: routeFailoverState.count,
          responseBodyObject: responseObject,
          responseBodyHash: contentHash(responseBuffer),
          errorMessage: response.ok ? null : redactSensitiveText(responseBuffer.toString('utf8'), 2000),
          completedAt: new Date()
        }).where(eq(requestLogs.id, log.id)))
        await bestEffort(touchKeyCredential(event, key.id))
        await bestEffort(recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: parsed.model, endpoint, status: response.ok ? 'success' : 'error', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, affinityReused: affinityWasReused, affinityEligible: Boolean(affinityKey), totalTokens: usage.totalTokens, cost, durationMs: Date.now() - startedAt, failovers: routeFailoverState.count }))
        await settleAdmissions(usage.totalTokens, cost)
        settled = true
        if (!await settleWalletReservation(cost)) throw new Error('钱包结算失败')
        if (!await releaseTrackedChannel(channelLease)) throw new Error('无法释放渠道并发租约')
        if (response.ok) {
          await bestEffort(recordChannelSuccess(event, candidate.channel.id, candidate.channel.ownerKind === 'user' ? candidate.protocolBinding.id : undefined))
          await bestEffort(rememberAffinitySelection(event, affinityKey, candidate))
        }
        else {
          const failureText = upstreamResponseBuffer.toString('utf8').slice(0, 2000)
          const failureClass = classifyRelayFailure(response.status, failureText)
          if (candidate.channel.ownerKind === 'user') await bestEffort(markUserRelayFailure(event, candidate.channel.id, failureClass, failureText))
          if (relayFailureAffectsAccount(failureClass)) await bestEffort(recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`))
        }
        responseHeaders(event, response, requestId)
        if (candidate.conversionMode === 'responses_to_chat') setResponseHeader(event, 'content-type', clientResponseContentType)
        if (!response.ok) {
          setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
          return responseBuffer
        }
        return responseBuffer
      } catch (error) {
        stopUpstreamTimeout()
        await closePinned()
        if (responseStarted) throw error
        const localStatus = Number((error as { statusCode?: number }).statusCode || 0)
        if (!candidateRequestStarted && localStatus >= 400 && localStatus < 500) {
          if (!await releaseTrackedChannel(channelLease)) throw new Error('无法释放渠道并发租约')
          throw error
        }
        await bestEffort(useDatabase(event).insert(requestAttempts).values({
          requestLogId: log.id,
          channelId: candidate.channel.id,
          protocolBindingId: candidate.protocolBinding.id,
          attempt: attemptCount,
          status: 'failed',
          durationMs: Date.now() - attemptStarted,
          errorMessage: redactSensitiveText(error instanceof Error ? error.message : 'Unknown upstream error', 2000), failureClass: 'upstream_unavailable',
          ...resourceFields(candidate)
        }))
        const requestIncompatible = (error as { statusCode?: number }).statusCode === 422
        if (!requestIncompatible) await bestEffort(recordChannelFailure(event, candidate.channel.id, error instanceof Error ? error.message : 'upstream error'))
        if (!await releaseTrackedChannel(channelLease)) throw new Error('无法释放渠道并发租约')
        if (endpoint.startsWith('/v1/images/')) throw error
        if (upstreamHeadersReceived) throw error
        if (index === candidates.length - 1) throw error
      } finally {
        if (streamArchive && !streamArchive.destroyed) streamArchive.destroy()
        if (streamDirectory) await rm(streamDirectory, { recursive: true, force: true }).catch(() => {})
      }
    }
    if (packageAdmissionError && attemptCount === 0) throw packageAdmissionError
    throw new Error('All matching channels are at their concurrency limit')
  } catch (error) {
    if (idempotency) await failIdempotency(event, idempotency.record.id, upstreamRequestStarted).catch(() => {})
    if (admittedChannel) await releaseTrackedChannel(admittedChannel)
    if (!settled) {
      if (!baseAdmissionSettled) await settleBaseAdmission()
      await releasePackageReservation()
    }
    if (walletHeld && walletHoldKey) {
      if (walletSettlementCost !== null) await settleWalletReservation(walletSettlementCost)
      else await releasePackageReservation()
    }
    const message = redactSensitiveText(error instanceof Error ? error.message : 'All upstream channels failed', 2000)
    const failureStatus = Number((error as { statusCode?: number }).statusCode || 0)
    const httpStatus = failureStatus >= 400 && failureStatus < 600 ? failureStatus : 502
    await bestEffort(useDatabase(event).update(requestLogs).set({
      channelId: lastCandidate?.channel.id || null,
      protocolBindingId: lastCandidate?.protocolBinding.id || null,
      upstreamModel: lastCandidate?.upstreamModel || null,
      reasoningEffort: effectiveReasoningEffort,
      ...(lastCandidate ? resourceFields(lastCandidate) : {}),
      status: 'error', httpStatus, errorMessage: redactSensitiveText(message, 2000), durationMs: Date.now() - startedAt, failoverCount: routeFailoverState.count, completedAt: new Date()
    }).where(eq(requestLogs.id, log.id)))
    await bestEffort(recordUsageRollups(event, {
      keyId: key.id,
      userId,
      groupId: group.id,
      channelId: lastCandidate?.channel.id || null,
      protocolBindingId: lastCandidate?.protocolBinding.id || null,
      protocol: lastCandidate?.protocolBinding.protocol || null,
      model: parsed.model,
      endpoint,
      status: 'error',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      durationMs: Date.now() - startedAt,
      failovers: routeFailoverState.count
    }))
    if (responseStarted) return
    const failure = error as { statusCode?: number; message?: string }
    if (failure.statusCode === 429) openAiError(429, failure.message || '当前套餐额度已用尽', 'rate_limit_error', 'rate_limit_exceeded')
    if (failureStatus >= 400 && failureStatus < 500 && !upstreamRequestStarted) throw error
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
  const message = redactSensitiveText(failure.data?.error?.message || failure.message || 'Zephyr Hub internal error', 2000)
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
