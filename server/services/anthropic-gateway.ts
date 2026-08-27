import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { groupModelRules, keyModelRules, requestAttempts, requestLogs, servicePlanVersions, usageRollups, userPoolAccounts, userPoolGroups, userRelayGroups, userSubscriptions, servicePlans } from '../db/schema'
import { contentHash, decryptChannelSecret, hashCacheAffinity, hashClientIp } from '../utils/hub-crypto'
import { pinnedUpstreamFetch, upstreamTarget } from '../utils/upstream-url'
import { trustedClientIp } from '../utils/client-ip'
import { copyUpstreamClientIdentity } from '../utils/upstream-client-identity'
import { acquireChannel, admitHubRequest, releaseChannel, settleHubRequest, type ChannelConcurrencyLease } from './hub-limits'
import { authenticateHubRequest, calculateCost, enforceRequestProtection, estimateReservation, listAccessibleModels, readUpstreamChunk, sanitizeArchiveBody, storeBodySafe, storeFileSafe, touchKeyCredential, writeResponseChunk } from './hub-gateway'
import { orderedRouteSourceNodes, recordChannelFailure, recordChannelSuccess, rememberAffinitySelection, routeCandidates, selectSupplySource, userRelayAccountAllowsRouting, type SupplyDecision } from './hub-routing'
import { recordUsageRollups } from './hub-rollups'
import { effectivePriceMultiplier, policyAllows } from './group-policy'
import { getHubSettings } from './hub-settings'
import { assertTrafficAccepting } from './hub-traffic'
import { getActiveSubscription } from './customer-management'
import { holdUserWallet, releaseUserWallet, settleUserWallet } from './user-wallet'
import { anthropicToOpenAiChat, anthropicUsage, openAiChatToAnthropic, openAiUsage } from './protocols/anthropic-openai'
import { pipeOpenAiChatAsAnthropic } from './protocols/anthropic-stream'
import type { CanonicalUsage } from './protocols/canonical'
import { getUserFailoverSourceIds } from './user-route-preferences'
import { classifyRelayFailure, relayFailureAffectsAccount, relayFailureAllowsFailover } from './relay-platform'
import { MAX_UPSTREAM_RETRIES, shouldRetryUpstream, shouldRetryUpstreamError, upstreamRetryDelay, waitForUpstreamRetry } from './upstream-retry'
import { markUserRelayFailure } from './user-relays'

const MAX_BODY_BYTES = 50 * 1024 * 1024
const USAGE_TAIL_BYTES = 4 * 1024 * 1024
function anthropicError(status: number, message: string, type = 'api_error'): never {
  throw createError({ statusCode: status, data: { type: 'error', error: { type, message } } })
}

function parseBody(raw: Buffer): Record<string, unknown> & { model: string } {
  try {
    const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    if (typeof body.model !== 'string' || !body.model.trim()) anthropicError(400, 'model is required', 'invalid_request_error')
    if (!Array.isArray(body.messages)) anthropicError(400, 'messages must be an array', 'invalid_request_error')
    return { ...body, model: body.model.trim() }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error
    anthropicError(400, 'Request body must be valid JSON', 'invalid_request_error')
  }
}

function upstreamHeaders(event: H3Event, apiKey: string, authScheme: 'bearer' | 'x_api_key', apiVersion: string | null, directAnthropic: boolean, clientIdentityMode: string) {
  const headers = new Headers({ 'content-type': 'application/json', accept: getHeader(event, 'accept') || 'application/json' })
  if (authScheme === 'x_api_key') {
    headers.set('x-api-key', apiKey)
    headers.set('anthropic-version', apiVersion || '2023-06-01')
  } else headers.set('authorization', `Bearer ${apiKey}`)
  const beta = getHeader(event, 'anthropic-beta')
  if (directAnthropic && beta && /^[a-z0-9,_-]+$/i.test(beta) && beta.length <= 500) headers.set('anthropic-beta', beta)
  if (clientIdentityMode === 'passthrough') copyUpstreamClientIdentity(event, headers)
  return headers
}

function appendTail(current: Buffer, chunk: Buffer) {
  if (chunk.length >= USAGE_TAIL_BYTES) return chunk.subarray(chunk.length - USAGE_TAIL_BYTES)
  const combined = Buffer.concat([current, chunk])
  return combined.length > USAGE_TAIL_BYTES ? combined.subarray(combined.length - USAGE_TAIL_BYTES) : combined
}

function anthropicStreamUsage(buffer: Buffer) {
  let latest: CanonicalUsage | null = null
  for (const line of buffer.toString('utf8').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      const usage = anthropicUsage(JSON.parse(line.slice(5).trim()))
      if (usage.totalTokens) latest = usage
    } catch {}
  }
  return latest || { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0 }
}

function usageForBilling(usage: CanonicalUsage) {
  return { ...usage, imageCount: 0 }
}

function anthropicBlocks(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const content = (message as { content?: unknown }).content
    return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object') : []
  })
}

function validateChatConversion(body: Record<string, unknown>, capabilities: Record<string, boolean>) {
  const blocks = anthropicBlocks(body)
  if ((Array.isArray(body.tools) && body.tools.length || blocks.some(block => block.type === 'tool_use' || block.type === 'tool_result')) && capabilities.tools === false) {
    anthropicError(400, 'The selected model does not support tool use', 'invalid_request_error')
  }
  if (blocks.some(block => block.type === 'image') && capabilities.vision !== true) {
    anthropicError(400, 'The selected model has not been verified for image input', 'invalid_request_error')
  }
  if (body.thinking || blocks.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')) {
    anthropicError(400, 'Thinking blocks cannot be converted to Chat Completions without losing semantics', 'invalid_request_error')
  }
}

function upstreamError(buffer: Buffer, status: number) {
  try {
    const payload = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
    const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : null
    const message = typeof error?.message === 'string' ? error.message : typeof payload.message === 'string' ? payload.message : `Upstream returned HTTP ${status}`
    return Buffer.from(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: message.slice(0, 2000) } }))
  } catch {
    return Buffer.from(JSON.stringify({ type: 'error', error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message: buffer.toString('utf8').slice(0, 2000) || `Upstream returned HTTP ${status}` } }))
  }
}

export async function handleAnthropicModels(event: H3Event) {
  if (event.method !== 'GET') anthropicError(405, 'Method not allowed', 'invalid_request_error')
  const access = await authenticateHubRequest(event)
  const { key, group, userId } = access
  await assertTrafficAccepting(event)
  if (!policyAllows(key.allowedEndpoints, '/v1/models') || !policyAllows(group.allowedEndpoints, '/v1/models')) anthropicError(403, 'This Hub Key cannot list models', 'permission_error')
  const lease = await admitHubRequest(event, key, group, 0, 0, { scopeMode: 'base_only' })
  try {
    const result = await listAccessibleModels(event, key, group, userId, ['anthropic_messages', 'openai_chat'])
    await touchKeyCredential(event, key.id)
    const data = result.data.map(model => ({ type: 'model', id: model.id, display_name: model.id, created_at: '1970-01-01T00:00:00Z' }))
    return { data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null }
  } finally {
    await settleHubRequest(event, key, group, 0, 0, 0, 0, lease)
  }
}

export async function handleAnthropicMessages(event: H3Event) {
  if (event.method !== 'POST') anthropicError(405, 'Method not allowed', 'invalid_request_error')
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (declared > MAX_BODY_BYTES) anthropicError(413, 'Request body is too large', 'invalid_request_error')
  const access = await authenticateHubRequest(event)
  const { key, group, userId } = access
  await assertTrafficAccepting(event)
  const rawText = await readRawBody(event, false)
  const raw = Buffer.isBuffer(rawText) ? rawText : Buffer.from(rawText || '')
  if (raw.length > MAX_BODY_BYTES) anthropicError(413, 'Request body is too large', 'invalid_request_error')
  const body = parseBody(raw)
  const endpoint = '/v1/messages'
  if (!policyAllows(key.allowedEndpoints, endpoint) || !policyAllows(group.allowedEndpoints, endpoint)) anthropicError(403, 'This Hub Key cannot use the Messages endpoint', 'permission_error')
  const [keyModels, groupModels] = await Promise.all([
    useDatabase(event).select().from(keyModelRules).where(eq(keyModelRules.keyId, key.id)),
    useDatabase(event).select().from(groupModelRules).where(eq(groupModelRules.groupId, group.id))
  ])
  const requestedModel = String(body.model)
  event.context.hubRequestedModel = requestedModel
  if (keyModels.length && !keyModels.some(rule => rule.publicModel === requestedModel)) anthropicError(403, 'This Hub Key cannot use the requested model', 'permission_error')
  if (groupModels.length && !groupModels.some(rule => rule.publicModel === requestedModel)) anthropicError(403, 'This group cannot use the requested model', 'permission_error')
  const affinityKey = hashCacheAffinity(event, { scope: `${userId}:${key.id}`, protocol: 'anthropic_messages', model: requestedModel, system: body.system, tools: body.tools, sessionId: getHeader(event, 'x-zephyr-session-id') || null })
  const routeOptions = { userId, keyId: key.id, protocol: 'anthropic_messages' as const, allowConversion: true, affinityKey }
  const sourceIds = await getUserFailoverSourceIds(event, userId)
  const sourceNodes = orderedRouteSourceNodes(key.routeMode, sourceIds)
  const [privatePool] = await useDatabase(event).select().from(userPoolGroups).where(and(eq(userPoolGroups.ownerUserId, userId), eq(userPoolGroups.status, 'active'))).limit(1)
  const privatePoolAvailable = Boolean(privatePool && (await useDatabase(event).select({ id: userPoolAccounts.id }).from(userPoolAccounts).where(and(eq(userPoolAccounts.poolGroupId, privatePool.id), eq(userPoolAccounts.status, 'active'), eq(userPoolAccounts.schedulable, true))).limit(1))[0])
  const candidateBatches = await Promise.all(sourceNodes.map(async node => ({
    node,
    candidates: node.source === 'platform'
      ? await routeCandidates(event, requestedModel, endpoint, group.id, 'platform', undefined, routeOptions)
      : node.source === 'private_pool'
        ? privatePoolAvailable ? await routeCandidates(event, requestedModel, endpoint, group.id, 'private_pool', privatePool!.id, routeOptions) : []
        : await routeCandidates(event, requestedModel, endpoint, group.id, 'user_relay', undefined, { ...routeOptions, channelId: node.channelId, relayGroupId: node.relayGroupId })
  })))
  const initialCandidates = candidateBatches.flatMap(batch => batch.candidates)
  if (!initialCandidates.length) anthropicError(503, `No healthy channel supports model ${requestedModel}`, 'api_error')
  const reservation = await estimateReservation(event, requestedModel, endpoint, body, raw.length, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Math.max(...initialCandidates.map(candidate => Number(candidate.channel.priceMultiplier)))))
  const requestId = typeof event.context.hubRequestId === 'string' ? event.context.hubRequestId : `req_${crypto.randomUUID().replace(/-/g, '')}`
  let packageDecision: SupplyDecision | null = null
  let billingMode = 'unlimited'
  const hasPackageNode = candidateBatches.some(batch => batch.node.source === 'platform')
  const activeSubscription = hasPackageNode ? await getActiveSubscription(event, userId) : null
  if (hasPackageNode && activeSubscription) {
    const version = activeSubscription.subscription.planVersionId
      ? (await useDatabase(event).select().from(servicePlanVersions).where(eq(servicePlanVersions.id, activeSubscription.subscription.planVersionId)).limit(1))[0]
      : null
    const snapshot = activeSubscription.subscription.entitlementSnapshot || {}
    billingMode = String(version?.billingMode || snapshot.billingMode || (activeSubscription.plan.mode === 'token' ? 'token_package' : activeSubscription.plan.mode === 'cost' ? 'token_metered' : 'unlimited'))
    const supplyMode = String(version?.supplyMode || snapshot.supplyMode || 'platform_only')
    const tokenLimit = Number(version?.tokenLimit ?? snapshot.tokenLimit ?? activeSubscription.plan.tokenLimit ?? 0)
    const usedRow = tokenLimit > 0
      ? (await useDatabase(event).select({ tokens: sql<number>`coalesce(sum(${usageRollups.totalTokens}), 0)` }).from(usageRollups).where(and(eq(usageRollups.userId, userId), eq(usageRollups.granularity, 'day'), gte(usageRollups.bucketStart, activeSubscription.subscription.startsAt))))[0]
      : null
    try {
      packageDecision = selectSupplySource({
        billingMode,
        supplyMode,
        estimatedTokens: reservation.tokens,
        remainingTokens: tokenLimit > 0 ? Math.max(0, tokenLimit - Number(usedRow?.tokens || 0)) : null,
        privatePoolAvailable,
        subscriptionId: activeSubscription.subscription.id,
        planVersionId: version?.id || activeSubscription.subscription.planVersionId,
        poolGroupId: privatePool?.id
      })
    } catch (error) {
      if (!candidateBatches.some(batch => batch.node.source !== 'platform' && batch.candidates.length)) throw error
    }
  }
  const candidates: Awaited<ReturnType<typeof routeCandidates>> = []
  for (const batch of candidateBatches) {
    if (batch.node.source === 'user_relay' || batch.node.source === 'private_pool') candidates.push(...batch.candidates)
    else if (packageDecision?.source === 'platform') candidates.push(...batch.candidates)
  }
  if (!candidates.length) anthropicError(503, '没有可用来源支持当前模型', 'api_error')
  const supplyDecision: SupplyDecision = candidates[0]!.supplySource === 'user_relay'
    ? { source: 'user_relay', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    : candidates[0]!.supplySource === 'private_pool'
      ? { source: 'private_pool', subscriptionId: null, planVersionId: null, reservedTokens: 0, poolGroupId: privatePool?.id }
      : packageDecision || { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
  const affinityWasReused = candidates[0]?.affinityReused === true
  event.context.hubSupplySource = supplyDecision.source
  event.context.hubPoolGroupId = supplyDecision.poolGroupId
  event.context.hubSubscriptionId = supplyDecision.subscriptionId
  event.context.hubPlanVersionId = supplyDecision.planVersionId
  enforceRequestProtection(key, reservation)
  let walletHoldKey: string | null = null
  let walletHeld = false
  let concurrencyLease: Awaited<ReturnType<typeof admitHubRequest>>
  try {
    if (billingMode === 'token_metered' && supplyDecision.source !== 'user_relay' && reservation.cost > 0) {
      walletHoldKey = `request:${requestId}:hold`
      await holdUserWallet(event, userId, reservation.cost, walletHoldKey, requestId)
      walletHeld = true
    }
    concurrencyLease = await admitHubRequest(event, key, group, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, { skipSubscriptionQuota: supplyDecision.source === 'user_relay' || supplyDecision.source === 'private_pool' })
  } catch (error) {
    if (walletHeld && walletHoldKey) await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
    throw error
  }
  const settings = await getHubSettings(event)
  const relayGroupIds = [...new Set(candidates.map(candidate => candidate.relayGroupId).filter((value): value is string => Boolean(value)))]
  const relayGroupRows = relayGroupIds.length ? await useDatabase(event).select({ id: userRelayGroups.id, name: userRelayGroups.name }).from(userRelayGroups).where(inArray(userRelayGroups.id, relayGroupIds)) : []
  const relayGroupNames = new Map(relayGroupRows.map(row => [row.id, row.name]))
  const [packagePlan] = supplyDecision.subscriptionId
    ? await useDatabase(event).select({ name: servicePlans.name }).from(userSubscriptions).innerJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id)).where(eq(userSubscriptions.id, supplyDecision.subscriptionId)).limit(1)
    : []
  const resourceFields = (candidate: typeof candidates[number]) => {
    const resourceType = candidate.supplySource === 'user_relay' ? 'user_relay' as const : candidate.supplySource === 'private_pool' ? 'private_pool' as const : 'subscription' as const
    const resourceId = candidate.supplySource === 'user_relay' ? candidate.relayGroupId || candidate.channel.id : candidate.supplySource === 'private_pool' ? privatePool?.id || null : supplyDecision.subscriptionId
    const resourceName = candidate.supplySource === 'user_relay' ? relayGroupNames.get(candidate.relayGroupId || '') || candidate.channel.name : candidate.supplySource === 'private_pool' ? privatePool?.displayName || '我的专属号池' : packagePlan?.name || '当前套餐'
    return { resourceType, resourceId, resourceNameSnapshot: resourceName, executionNameSnapshot: candidate.channel.accountLabel || candidate.channel.name, userRelayGroupId: candidate.relayGroupId || null }
  }
  let log: typeof requestLogs.$inferSelect | undefined
  try {
    [log] = await useDatabase(event).insert(requestLogs).values({
      requestId, keyId: key.id, userId, groupId: group.id, endpoint, requestedModel, inboundProtocol: 'anthropic_messages', supplySource: supplyDecision.source,
      ...resourceFields(candidates[0]!), poolGroupId: supplyDecision.poolGroupId || null, subscriptionId: supplyDecision.subscriptionId, planVersionId: supplyDecision.planVersionId,
      status: 'pending', streaming: body.stream === true, billableTokens: reservation.tokens, billedAmount: String(supplyDecision.source === 'user_relay' ? 0 : reservation.cost),
      clientIpHash: hashClientIp(trustedClientIp(event), event), requestBodyHash: contentHash(raw), bodyExpiresAt: new Date(Date.now() + settings.bodyRetentionDays * 86400_000)
    }).returning()
  } catch (error) {
    await settleHubRequest(event, key, group, 0, 0, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, concurrencyLease).catch(() => {})
    if (walletHeld && walletHoldKey) await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
    throw error
  }
  if (!log) {
    await settleHubRequest(event, key, group, 0, 0, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, concurrencyLease).catch(() => {})
    if (walletHeld && walletHoldKey) await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
    anthropicError(500, 'Unable to initialize request log')
  }
  const requestObject = await storeBodySafe(event, requestId, 'request', sanitizeArchiveBody(raw, 'application/json'), 'application/json')
  if (requestObject) await useDatabase(event).update(requestLogs).set({ requestBodyObject: requestObject }).where(eq(requestLogs.id, log.id))

  let admitted: ChannelConcurrencyLease | null = null
  let settled = false
  let attempts = 0
  let lastCandidate: typeof candidates[number] | null = null
  let responseStarted = false
  try {
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!
      if (candidate.channel.ownerKind === 'user' && !await userRelayAccountAllowsRouting(event, candidate.channel.id)) continue
      const lease = await acquireChannel(event, candidate.channel.id, candidate.channel.maxConcurrency, candidate.relayGroupId ? { id: candidate.relayGroupId, max: candidate.relayGroupMaxConcurrency || null } : undefined)
      if (!lease) continue
      admitted = lease
      lastCandidate = candidate
      const started = Date.now()
      let attemptStarted = started
      let closePinned: (() => Promise<void>) | null = null
      let controller: AbortController | null = null
      let upstreamTimer: ReturnType<typeof setTimeout> | null = null
      let streamDirectory: string | null = null
      let streamArchive: ReturnType<typeof createWriteStream> | null = null
      const abortUpstream = () => controller?.abort(new Error('Client disconnected'))
      const closeConnection = async () => {
        event.node.res.off('close', abortUpstream)
        const close = closePinned
        if (close) await close().catch(() => {})
      }
      try {
        const direct = candidate.protocolBinding.protocol === 'anthropic_messages'
        if (!direct) validateChatConversion(body, candidate.modelBinding.capabilities)
        const outgoing = direct ? { ...body, model: candidate.upstreamModel } : anthropicToOpenAiChat(body, candidate.upstreamModel)
        const path = direct ? '/v1/messages' : '/v1/chat/completions'
        const base = candidate.protocolBinding.baseUrlOverride || candidate.channel.baseUrl
        const credential = candidate.credential || decryptChannelSecret(candidate.channel.encryptedApiKey, candidate.channel.id, candidate.channel.ownerKind, event)
        const headers = upstreamHeaders(event, credential, candidate.protocolBinding.authScheme, candidate.protocolBinding.apiVersion, direct, candidate.channel.clientIdentityMode)
        const requestController = new AbortController()
        controller = requestController
        event.node.res.once('close', abortUpstream)
        upstreamTimer = setTimeout(() => requestController.abort(new Error('Upstream request timed out')), candidate.channel.timeoutMs)
        upstreamTimer.unref()
        let response: Response
        let prefetchedResponseBuffer: Buffer | null = null
        let responseFailureClass = null as ReturnType<typeof classifyRelayFailure> | null
        for (let retryIndex = 0; ; retryIndex++) {
          attempts += 1
          attemptStarted = Date.now()
          try {
            response = candidate.channel.ownerKind === 'user'
              ? await (async () => {
                  const result = await pinnedUpstreamFetch(base, path, { method: 'POST', headers, body: JSON.stringify(outgoing), signal: requestController.signal })
                  closePinned = result.close
                  return result.response as unknown as Response
                })()
              : await fetch(upstreamTarget(base, path), { method: 'POST', headers, body: JSON.stringify(outgoing), redirect: 'manual', signal: requestController.signal })
          } catch (error) {
            if (retryIndex >= MAX_UPSTREAM_RETRIES || requestController.signal.aborted || !shouldRetryUpstreamError(error)) throw error
            await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'retrying', durationMs: Date.now() - attemptStarted, errorMessage: error instanceof Error ? error.message.slice(0, 2000) : 'Temporary upstream network error', failureClass: 'upstream_unavailable', ...resourceFields(candidate) })
            await closeConnection()
            closePinned = null
            event.node.res.once('close', abortUpstream)
            await waitForUpstreamRetry(upstreamRetryDelay(null, retryIndex))
            continue
          }
          prefetchedResponseBuffer = null
          responseFailureClass = null
          if (!response.ok) {
            prefetchedResponseBuffer = Buffer.from(await response.arrayBuffer())
            responseFailureClass = classifyRelayFailure(response.status, prefetchedResponseBuffer.toString('utf8'))
          }
          const failureText = prefetchedResponseBuffer?.toString('utf8') || ''
          if (!shouldRetryUpstream(response.status, failureText) || retryIndex >= MAX_UPSTREAM_RETRIES) break
          await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'retrying', httpStatus: response.status, durationMs: Date.now() - attemptStarted, errorMessage: failureText.slice(0, 2000), failureClass: responseFailureClass || 'upstream_unavailable', ...resourceFields(candidate) })
          await closeConnection()
          closePinned = null
          event.node.res.once('close', abortUpstream)
          await waitForUpstreamRetry(upstreamRetryDelay(response.headers.get('retry-after'), retryIndex))
        }
        clearTimeout(upstreamTimer)
        upstreamTimer = null
        if (responseFailureClass && relayFailureAllowsFailover(response.status, responseFailureClass, candidate.channel.ownerKind === 'user') && index < candidates.length - 1) {
          const errorBody = prefetchedResponseBuffer!
          await closeConnection()
          const errorText = errorBody.toString('utf8').slice(0, 1000)
          await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'failed', httpStatus: response.status, durationMs: Date.now() - started, errorMessage: errorText, failureClass: responseFailureClass, ...resourceFields(candidate) })
          if (candidate.channel.ownerKind === 'user') await markUserRelayFailure(event, candidate.channel.id, responseFailureClass, errorText)
          if (relayFailureAffectsAccount(responseFailureClass)) await recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`)
          await releaseChannel(event, lease)
          admitted = null
          continue
        }
        if (body.stream === true && response.ok && response.body) {
          responseStarted = true
          setResponseStatus(event, response.status)
          setResponseHeader(event, 'content-type', 'text/event-stream; charset=utf-8')
          setResponseHeader(event, 'cache-control', 'no-cache')
          setResponseHeader(event, 'x-request-id', requestId)
          const directory = await mkdtemp(join(tmpdir(), 'zephyr-anthropic-'))
          streamDirectory = directory
          const pathName = join(directory, 'body')
          const archive = createWriteStream(pathName, { flags: 'wx' })
          streamArchive = archive
          const hash = createHash('sha256')
          let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
          let firstByteMs: number | null = null
          const write = async (value: Uint8Array) => {
            const chunk = Buffer.from(value)
            firstByteMs ??= Date.now() - started
            hash.update(chunk)
            tail = appendTail(tail, chunk)
            if (!archive.write(chunk)) await once(archive, 'drain')
            await writeResponseChunk(event.node.res, chunk)
          }
          let usage: CanonicalUsage
          if (direct) {
            const reader = response.body.getReader()
            while (true) {
              const { done, value } = await readUpstreamChunk(reader, candidate.channel.timeoutMs, requestController)
              if (done) break
              await write(value)
            }
            usage = anthropicStreamUsage(tail)
          } else usage = await pipeOpenAiChatAsAnthropic(response.body, requestedModel, write)
          archive.end()
          await once(archive, 'finish')
          if (!event.node.res.writableEnded) event.node.res.end()
          await closeConnection()
          const responseObject = await storeFileSafe(event, requestId, 'response', pathName, 'text/event-stream')
          await rm(directory, { recursive: true, force: true })
          streamDirectory = null
          streamArchive = null
          const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, requestedModel, usageForBilling(usage), body, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
          await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'success', httpStatus: response.status, durationMs: Date.now() - started, ...resourceFields(candidate) })
          await useDatabase(event).update(requestLogs).set({
            channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, outboundProtocol: candidate.protocolBinding.protocol, conversionMode: candidate.conversionMode,
            sourceOwnerKind: candidate.channel.ownerKind, sourceOwnerUserId: candidate.channel.ownerUserId, cacheAffinityReused: affinityWasReused,
            ...resourceFields(candidate),
            upstreamModel: candidate.upstreamModel, status: 'success', httpStatus: response.status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
            cost: String(cost), billableTokens: usage.totalTokens, billedAmount: String(cost), firstByteMs: firstByteMs ?? Date.now() - started, durationMs: Date.now() - started,
            failoverCount: Math.max(0, attempts - 1), responseBodyObject: responseObject, responseBodyHash: hash.digest('hex'), completedAt: new Date()
          }).where(eq(requestLogs.id, log.id))
          await recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: requestedModel, endpoint, status: 'success', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, affinityReused: affinityWasReused, affinityEligible: true, totalTokens: usage.totalTokens, cost, durationMs: Date.now() - started, failovers: Math.max(0, attempts - 1) })
          await settleHubRequest(event, key, group, usage.totalTokens, cost, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, concurrencyLease)
          if (walletHeld && walletHoldKey) { await settleUserWallet(event, userId, walletHoldKey, cost, `request:${requestId}:settle`, requestId); walletHeld = false }
          settled = true
          await releaseChannel(event, lease)
          admitted = null
          await touchKeyCredential(event, key.id)
          await recordChannelSuccess(event, candidate.channel.id, candidate.channel.ownerKind === 'user' ? candidate.protocolBinding.id : undefined)
          await rememberAffinitySelection(event, affinityKey, candidate)
          return
        }
        const upstreamBuffer = prefetchedResponseBuffer || Buffer.from(await response.arrayBuffer())
        await closeConnection()
        const usage = direct ? anthropicUsage(JSON.parse(upstreamBuffer.toString('utf8') || '{}')) : openAiUsage((JSON.parse(upstreamBuffer.toString('utf8') || '{}') as Record<string, unknown>).usage)
        const output = response.ok && !direct ? Buffer.from(JSON.stringify(openAiChatToAnthropic(JSON.parse(upstreamBuffer.toString('utf8')), requestedModel))) : response.ok ? upstreamBuffer : upstreamError(upstreamBuffer, response.status)
        const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, requestedModel, usageForBilling(usage), body, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
        const responseObject = await storeBodySafe(event, requestId, 'response', output, 'application/json')
        await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: response.ok ? 'success' : 'failed', httpStatus: response.status, durationMs: Date.now() - started, failureClass: response.ok ? null : classifyRelayFailure(response.status, output.toString('utf8')), ...resourceFields(candidate) })
        await useDatabase(event).update(requestLogs).set({
          channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, outboundProtocol: candidate.protocolBinding.protocol, conversionMode: candidate.conversionMode,
          sourceOwnerKind: candidate.channel.ownerKind, sourceOwnerUserId: candidate.channel.ownerUserId, cacheAffinityReused: affinityWasReused,
          ...resourceFields(candidate),
          upstreamModel: candidate.upstreamModel, status: response.ok ? 'success' : 'error', httpStatus: response.status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
          cost: String(cost), billableTokens: usage.totalTokens, billedAmount: String(cost), firstByteMs: Date.now() - started, durationMs: Date.now() - started,
          failoverCount: Math.max(0, attempts - 1), responseBodyObject: responseObject, responseBodyHash: contentHash(output), errorMessage: response.ok ? null : output.toString('utf8').slice(0, 2000), completedAt: new Date()
        }).where(eq(requestLogs.id, log.id))
        await recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: requestedModel, endpoint, status: response.ok ? 'success' : 'error', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, affinityReused: affinityWasReused, affinityEligible: true, totalTokens: usage.totalTokens, cost, durationMs: Date.now() - started, failovers: Math.max(0, attempts - 1) })
        await settleHubRequest(event, key, group, usage.totalTokens, cost, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, concurrencyLease)
        if (walletHeld && walletHoldKey) { await settleUserWallet(event, userId, walletHoldKey, cost, `request:${requestId}:settle`, requestId); walletHeld = false }
        settled = true
        await releaseChannel(event, lease)
        admitted = null
        await touchKeyCredential(event, key.id)
        if (response.ok) {
          await recordChannelSuccess(event, candidate.channel.id, candidate.channel.ownerKind === 'user' ? candidate.protocolBinding.id : undefined)
          await rememberAffinitySelection(event, affinityKey, candidate)
        }
        else {
          const failureText = output.toString('utf8').slice(0, 2000)
          const failureClass = classifyRelayFailure(response.status, failureText)
          if (candidate.channel.ownerKind === 'user') await markUserRelayFailure(event, candidate.channel.id, failureClass, failureText)
          if (relayFailureAffectsAccount(failureClass)) await recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`)
        }
        setResponseStatus(event, response.status)
        setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
        setResponseHeader(event, 'x-request-id', requestId)
        return output
      } catch (error) {
        if (upstreamTimer) clearTimeout(upstreamTimer)
        if (streamArchive && !streamArchive.destroyed) streamArchive.destroy()
        if (streamDirectory) await rm(streamDirectory, { recursive: true, force: true }).catch(() => {})
        await closeConnection()
        await releaseChannel(event, lease)
        admitted = null
        await recordChannelFailure(event, candidate.channel.id, error instanceof Error ? error.message : 'upstream error')
        await useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'failed', durationMs: Date.now() - started, errorMessage: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown upstream error', failureClass: 'upstream_unavailable', ...resourceFields(candidate) })
        if (responseStarted) {
          const message = error instanceof Error ? error.message.slice(0, 500) : 'Upstream stream failed'
          if (!event.node.res.destroyed && !event.node.res.writableEnded) {
            await writeResponseChunk(event.node.res, Buffer.from(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`)).catch(() => false)
            if (!event.node.res.writableEnded) event.node.res.end()
          }
          await useDatabase(event).update(requestLogs).set({
            channelId: candidate.channel.id,
            protocolBindingId: candidate.protocolBinding.id,
            outboundProtocol: candidate.protocolBinding.protocol,
            conversionMode: candidate.conversionMode,
            sourceOwnerKind: candidate.channel.ownerKind,
            sourceOwnerUserId: candidate.channel.ownerUserId,
            ...resourceFields(candidate),
            upstreamModel: candidate.upstreamModel,
            status: 'error',
            httpStatus: 502,
            errorMessage: message,
            durationMs: Date.now() - started,
            failoverCount: Math.max(0, attempts - 1),
            completedAt: new Date()
          }).where(eq(requestLogs.id, log.id))
          await settleHubRequest(event, key, group, 0, 0, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, concurrencyLease).catch(() => {})
          if (walletHeld && walletHoldKey) { await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {}); walletHeld = false }
          settled = true
          return
        }
        if (index === candidates.length - 1) throw error
      }
    }
    anthropicError(503, 'All matching channels are at their concurrency limit', 'overloaded_error')
  } catch (error) {
    if (admitted) await releaseChannel(event, admitted).catch(() => {})
    if (!settled) await settleHubRequest(event, key, group, 0, 0, reservation.tokens, supplyDecision.source === 'user_relay' ? 0 : reservation.cost, concurrencyLease).catch(() => {})
    if (walletHeld && walletHoldKey) { await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {}); walletHeld = false }
    const message = error instanceof Error ? error.message : 'All upstream channels failed'
    await useDatabase(event).update(requestLogs).set({
      channelId: lastCandidate?.channel.id || null,
      protocolBindingId: lastCandidate?.protocolBinding.id || null,
      ...(lastCandidate ? resourceFields(lastCandidate) : {}),
      status: 'error', httpStatus: 502, errorMessage: message.slice(0, 2000), durationMs: 0, failoverCount: Math.max(0, attempts - 1), completedAt: new Date()
    }).where(eq(requestLogs.id, log.id))
    throw error
  }
}
