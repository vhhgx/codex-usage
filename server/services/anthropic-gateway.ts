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
import { acquireChannel, admitHubRequest, cancelHubAdmission, releaseChannel, settleHubRequest, type ChannelConcurrencyLease, type HubConcurrencyLease } from './hub-limits'
import { assertUpstreamResponseSize, authenticateHubRequest, budgetUpstreamReadableStream, calculateCost, createUpstreamResponseBudget, enforceRequestProtection, estimateReservation, listAccessibleModels, readRequestBodyLimited, readUpstreamBodyLimited, reserveBodyMemory, sanitizeArchiveBody, storeBodySafe, storeFileSafe, touchKeyCredential, UPSTREAM_RESPONSE_LIMITS, writeResponseChunk } from './hub-gateway'
import { advanceRouteFailoverState, orderedRouteSourceNodes, packagePolicyAllowsRouteSource, recordChannelFailure, recordChannelSuccess, rememberAffinitySelection, routeCandidates, selectSupplySource, userRelayAccountAllowsRouting, type RouteFailoverState, type SupplyDecision } from './hub-routing'
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
import { redactSensitiveText } from '../utils/upstream'

const MAX_BODY_BYTES = 50 * 1024 * 1024
const USAGE_TAIL_BYTES = 4 * 1024 * 1024
async function bestEffort(task: Promise<unknown>) {
  try {
    await task
    return true
  } catch {
    return false
  }
}
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
  headers.set('accept-encoding', 'identity')
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
    return Buffer.from(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: redactSensitiveText(message, 2000) } }))
  } catch {
    return Buffer.from(JSON.stringify({ type: 'error', error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message: redactSensitiveText(buffer.toString('utf8'), 2000) || `Upstream returned HTTP ${status}` } }))
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
    await bestEffort(touchKeyCredential(event, key.id))
    const data = result.data.map(model => ({ type: 'model', id: model.id, display_name: model.id, created_at: '1970-01-01T00:00:00Z' }))
    return { data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null }
  } finally {
    await settleHubRequest(event, key, group, 0, 0, 0, 0, lease).catch(() => {})
  }
}

export async function handleAnthropicMessages(event: H3Event) {
  if (event.method !== 'POST') anthropicError(405, 'Method not allowed', 'invalid_request_error')
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (declared > MAX_BODY_BYTES) anthropicError(413, 'Request body is too large', 'invalid_request_error')
  const access = await authenticateHubRequest(event)
  const { key, group, userId } = access
  await assertTrafficAccepting(event)
  const memory = reserveBodyMemory(
    event,
    Number.isFinite(declared) && declared > 0 ? declared : 64 * 1024,
    () => anthropicError(503, 'Gateway request body capacity is temporarily exhausted', 'api_error')
  )
  const raw = await readRequestBodyLimited(
    event,
    MAX_BODY_BYTES,
    memory,
    () => anthropicError(413, 'Request body is too large', 'invalid_request_error'),
    { onTimeout: () => anthropicError(408, 'Request body timed out', 'invalid_request_error') }
  )
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
  let packageSupplyMode = 'platform_only'
  const hasPackageNode = candidateBatches.some(batch => batch.node.source === 'platform')
  const activeSubscription = hasPackageNode ? await getActiveSubscription(event, userId) : null
  if (hasPackageNode && activeSubscription) {
    const version = activeSubscription.subscription.planVersionId
      ? (await useDatabase(event).select().from(servicePlanVersions).where(eq(servicePlanVersions.id, activeSubscription.subscription.planVersionId)).limit(1))[0]
      : null
    const snapshot = activeSubscription.subscription.entitlementSnapshot || {}
    billingMode = String(version?.billingMode || snapshot.billingMode || (activeSubscription.plan.mode === 'token' ? 'token_package' : activeSubscription.plan.mode === 'cost' ? 'token_metered' : 'unlimited'))
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
    if (!packagePolicyAllowsRouteSource(batch.node.source, {
      hasActiveSubscription: Boolean(activeSubscription),
      packageSupplyMode,
      packageDecisionSource: packageDecision?.source || null
    })) continue
    candidates.push(...batch.candidates)
  }
  if (!candidates.length) anthropicError(503, '没有可用来源支持当前模型', 'api_error')
  let supplyDecision: SupplyDecision = candidates[0]!.supplySource === 'user_relay'
    ? { source: 'user_relay', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    : candidates[0]!.supplySource === 'private_pool'
      ? { source: 'private_pool', subscriptionId: null, planVersionId: null, reservedTokens: 0, poolGroupId: privatePool?.id }
      : packageDecision || { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
  const affinityWasReused = candidates[0]?.affinityReused === true
  event.context.hubSupplySource = supplyDecision.source
  event.context.hubPoolGroupId = supplyDecision.poolGroupId
  event.context.hubSubscriptionId = supplyDecision.subscriptionId
  event.context.hubPlanVersionId = supplyDecision.planVersionId
  const settings = await getHubSettings(event)
  const relayGroupIds = [...new Set(candidates.map(candidate => candidate.relayGroupId).filter((value): value is string => Boolean(value)))]
  const relayGroupRows = relayGroupIds.length ? await useDatabase(event).select({ id: userRelayGroups.id, name: userRelayGroups.name }).from(userRelayGroups).where(inArray(userRelayGroups.id, relayGroupIds)) : []
  const relayGroupNames = new Map(relayGroupRows.map(row => [row.id, row.name]))
  const packageSubscriptionId = packageDecision?.source === 'platform' ? packageDecision.subscriptionId : null
  const [packagePlan] = packageSubscriptionId
    ? await useDatabase(event).select({ name: servicePlans.name }).from(userSubscriptions).innerJoin(servicePlans, eq(userSubscriptions.planId, servicePlans.id)).where(eq(userSubscriptions.id, packageSubscriptionId)).limit(1)
    : []
  const resourceFields = (candidate: typeof candidates[number]) => {
    const resourceType = candidate.supplySource === 'user_relay' ? 'user_relay' as const : candidate.supplySource === 'private_pool' ? 'private_pool' as const : 'subscription' as const
    const candidateDecision = candidate.supplySource === 'user_relay'
      ? { source: 'user_relay' as const, subscriptionId: null, planVersionId: null, reservedTokens: 0 }
      : candidate.supplySource === 'private_pool'
        ? { source: 'private_pool' as const, subscriptionId: null, planVersionId: null, reservedTokens: 0, poolGroupId: privatePool?.id }
        : packageDecision?.source === 'platform'
          ? packageDecision
          : { source: 'platform' as const, subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    const resourceId = candidate.supplySource === 'user_relay' ? candidate.relayGroupId || candidate.channel.id : candidate.supplySource === 'private_pool' ? candidateDecision.poolGroupId || null : candidateDecision.subscriptionId
    const resourceName = candidate.supplySource === 'user_relay' ? relayGroupNames.get(candidate.relayGroupId || '') || candidate.channel.name : candidate.supplySource === 'private_pool' ? privatePool?.displayName || '我的专属号池' : packagePlan?.name || '当前套餐'
    return { resourceType, resourceId, resourceNameSnapshot: resourceName, executionNameSnapshot: candidate.channel.accountLabel || candidate.channel.name, userRelayGroupId: candidate.relayGroupId || null }
  }
  enforceRequestProtection(key, reservation)
  let walletHoldKey: string | null = null
  let walletHeld = false
  let packageAdmissionLease: HubConcurrencyLease | null = null
  let packageAdmissionError: unknown = null
  let concurrencyLease: Awaited<ReturnType<typeof admitHubRequest>>
  try {
    // Admit key/group limits first. Package quota and wallet holds are tied to
    // the candidate actually selected and are activated below.
    concurrencyLease = await admitHubRequest(event, key, group, reservation.tokens, 0, { scopeMode: 'base_only' })
  } catch (error) {
    if (walletHeld && walletHoldKey) await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
    throw error
  }
  // Keep the base admission state available for every setup and request
  // failure path.  A lease is only considered settled after Redis confirms
  // the transaction; failed cleanup must remain retryable.
  let baseAdmissionSettled = false
  const settleBaseAdmission = async (totalTokens = 0, cost = 0) => {
    if (baseAdmissionSettled) return true
    const settled = await bestEffort(settleHubRequest(event, key, group, totalTokens, cost, reservation.tokens, 0, concurrencyLease))
    if (settled) baseAdmissionSettled = true
    return settled
  }
  const startedAt = Date.now()
  let log: typeof requestLogs.$inferSelect | undefined
  try {
    [log] = await useDatabase(event).insert(requestLogs).values({
      requestId, keyId: key.id, userId, groupId: group.id, endpoint, requestedModel, inboundProtocol: 'anthropic_messages', supplySource: supplyDecision.source,
      ...resourceFields(candidates[0]!), poolGroupId: supplyDecision.poolGroupId || null, subscriptionId: supplyDecision.subscriptionId, planVersionId: supplyDecision.planVersionId,
      status: 'pending', streaming: body.stream === true, billableTokens: reservation.tokens, billedAmount: String(supplyDecision.source === 'user_relay' ? 0 : reservation.cost),
      clientIpHash: hashClientIp(trustedClientIp(event), event), requestBodyHash: contentHash(raw), bodyExpiresAt: new Date(Date.now() + settings.bodyRetentionDays * 86400_000)
    }).returning()
  } catch (error) {
    await settleBaseAdmission()
    if (walletHeld && walletHoldKey) await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
    throw error
  }
  if (!log) {
    await settleBaseAdmission()
    if (walletHeld && walletHoldKey) await releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId).catch(() => {})
    anthropicError(500, 'Unable to initialize request log')
  }
  try {
    const requestObject = await storeBodySafe(event, requestId, 'request', sanitizeArchiveBody(raw, 'application/json'), 'application/json')
    if (requestObject) await bestEffort(useDatabase(event).update(requestLogs).set({ requestBodyObject: requestObject }).where(eq(requestLogs.id, log.id)))
  } catch (error) {
    await settleBaseAdmission()
    throw error
  }

  let admittedChannel: ChannelConcurrencyLease | null = null
  let settled = false
  let attempts = 0
  let routeFailoverState: RouteFailoverState = { candidateKey: null, count: 0 }
  let lastCandidate: typeof candidates[number] | null = null
  let responseStarted = false
  // A wallet settlement has a distinct idempotency key from a release. Keep
  // the intended amount until settlement is confirmed so cleanup never
  // converts a timed-out settlement into a conflicting release.
  let walletSettlementCost: number | null = null
  const releaseTrackedChannel = async (lease: ChannelConcurrencyLease) => {
    const released = await bestEffort(releaseChannel(event, lease))
    if (released && admittedChannel === lease) admittedChannel = null
    return released
  }
  const releasePackageReservation = async () => {
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
  const activateCandidateSupply = async (candidate: typeof candidates[number]) => {
    const nextDecision: SupplyDecision = candidate.supplySource === 'user_relay'
      ? { source: 'user_relay', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
      : candidate.supplySource === 'private_pool'
        ? { source: 'private_pool', subscriptionId: null, planVersionId: null, reservedTokens: 0, poolGroupId: privatePool?.id }
        : packageDecision?.source === 'platform'
          ? packageDecision
          : { source: 'platform', subscriptionId: null, planVersionId: null, reservedTokens: 0 }
    if (nextDecision.source === 'user_relay' || nextDecision.source === 'private_pool') {
      if (!await releasePackageReservation()) throw new Error('无法释放套餐预留')
    } else if (packageAdmissionError) {
      return false
    } else {
      try {
        if (!packageAdmissionLease && nextDecision.subscriptionId) {
          packageAdmissionLease = await admitHubRequest(event, key, group, reservation.tokens, reservation.cost, { scopeMode: 'subscription_only' })
        }
        if (billingMode === 'token_metered' && reservation.cost > 0 && !walletHeld) {
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
    await useDatabase(event).update(requestLogs).set({
      supplySource: supplyDecision.source,
      poolGroupId: supplyDecision.poolGroupId || null,
      subscriptionId: supplyDecision.subscriptionId,
      planVersionId: supplyDecision.planVersionId,
      billedAmount: String(supplyDecision.source === 'user_relay' ? 0 : reservation.cost),
      ...resourceFields(candidate)
    }).where(eq(requestLogs.id, log!.id))
    return true
  }
  const settleAdmissions = async (totalTokens: number, cost: number) => {
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
      const lease = await acquireChannel(event, candidate.channel.id, candidate.channel.maxConcurrency, candidate.relayGroupId ? { id: candidate.relayGroupId, max: candidate.relayGroupMaxConcurrency || null } : undefined)
      if (!lease) continue
      // Track the channel slot before supply activation. If activation or its
      // cleanup fails, the outer handler can retry releasing this exact lease.
      admittedChannel = lease
      let activated = false
      try {
        activated = await activateCandidateSupply(candidate)
      } catch (error) {
        if (!await releaseTrackedChannel(lease)) throw new Error('无法释放渠道并发租约')
        throw error
      }
      if (!activated) {
        if (!await releaseTrackedChannel(lease)) throw new Error('无法释放渠道并发租约')
        continue
      }
      routeFailoverState = advanceRouteFailoverState(routeFailoverState, candidate)
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
            await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'retrying', durationMs: Date.now() - attemptStarted, errorMessage: redactSensitiveText(error instanceof Error ? error.message : 'Temporary upstream network error', 2000), failureClass: 'upstream_unavailable', ...resourceFields(candidate) }))
            await closeConnection()
            closePinned = null
            event.node.res.once('close', abortUpstream)
            await waitForUpstreamRetry(upstreamRetryDelay(null, retryIndex))
            continue
          }
          prefetchedResponseBuffer = null
          responseFailureClass = null
          if (!response.ok) {
            prefetchedResponseBuffer = await readUpstreamBodyLimited(response, requestController, UPSTREAM_RESPONSE_LIMITS.errorBytes, {
              idleTimeoutMs: candidate.channel.timeoutMs,
              label: 'Upstream error response'
            })
            responseFailureClass = classifyRelayFailure(response.status, prefetchedResponseBuffer.toString('utf8'))
          }
          const failureText = prefetchedResponseBuffer?.toString('utf8') || ''
          if (!shouldRetryUpstream(response.status, failureText) || retryIndex >= MAX_UPSTREAM_RETRIES) break
          await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'retrying', httpStatus: response.status, durationMs: Date.now() - attemptStarted, errorMessage: redactSensitiveText(failureText, 2000), failureClass: responseFailureClass || 'upstream_unavailable', ...resourceFields(candidate) }))
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
          const errorText = redactSensitiveText(errorBody.toString('utf8'), 1000)
          await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'failed', httpStatus: response.status, durationMs: Date.now() - started, errorMessage: errorText, failureClass: responseFailureClass, ...resourceFields(candidate) }))
          if (candidate.channel.ownerKind === 'user') await bestEffort(markUserRelayFailure(event, candidate.channel.id, responseFailureClass, errorText))
          if (relayFailureAffectsAccount(responseFailureClass)) await bestEffort(recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`))
          if (!await releaseTrackedChannel(lease)) throw new Error('无法释放渠道并发租约')
          continue
        }
        if (body.stream === true && response.ok && response.body) {
          const declaredStreamBytes = Number(response.headers.get('content-length'))
          if (Number.isFinite(declaredStreamBytes) && declaredStreamBytes > 0) {
            assertUpstreamResponseSize(
              declaredStreamBytes,
              UPSTREAM_RESPONSE_LIMITS.streamBytes,
              requestController,
              'Upstream streaming response'
            )
          }
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
          const streamBudget = createUpstreamResponseBudget(requestController, {
            maxBytes: UPSTREAM_RESPONSE_LIMITS.streamBytes,
            timeoutMs: UPSTREAM_RESPONSE_LIMITS.streamTimeoutMs,
            label: 'Upstream streaming response'
          })
          const hash = createHash('sha256')
          let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
          let firstByteMs: number | null = null
          const write = async (value: Uint8Array) => {
            const chunk = Buffer.from(value)
            streamBudget.account(chunk, 'output')
            firstByteMs ??= Date.now() - started
            hash.update(chunk)
            tail = appendTail(tail, chunk)
            if (!archive.write(chunk)) await streamBudget.guard(once(archive, 'drain'))
            await streamBudget.guard(writeResponseChunk(event.node.res, chunk))
          }
          let usage: CanonicalUsage
          try {
            if (direct) {
              const reader = response.body.getReader()
              while (true) {
                const { done, value } = await streamBudget.read(reader, candidate.channel.timeoutMs)
                if (done) break
                await write(value)
              }
              usage = anthropicStreamUsage(tail)
            } else {
              const budgetedBody = budgetUpstreamReadableStream(response.body, streamBudget, candidate.channel.timeoutMs)
              usage = await pipeOpenAiChatAsAnthropic(budgetedBody, requestedModel, write)
            }
            const archiveFinished = once(archive, 'finish')
            archive.end()
            await streamBudget.guard(archiveFinished)
          } finally {
            streamBudget.finish()
          }
          if (!event.node.res.writableEnded) event.node.res.end()
          await closeConnection()
          const responseObject = await storeFileSafe(event, requestId, 'response', pathName, 'text/event-stream')
          const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, requestedModel, usageForBilling(usage), body, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
          await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'success', httpStatus: response.status, durationMs: Date.now() - started, ...resourceFields(candidate) }))
          await bestEffort(useDatabase(event).update(requestLogs).set({
            channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, outboundProtocol: candidate.protocolBinding.protocol, conversionMode: candidate.conversionMode,
            sourceOwnerKind: candidate.channel.ownerKind, sourceOwnerUserId: candidate.channel.ownerUserId, cacheAffinityReused: affinityWasReused,
            ...resourceFields(candidate),
            upstreamModel: candidate.upstreamModel, status: 'success', httpStatus: response.status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
            cost: String(cost), billableTokens: usage.totalTokens, billedAmount: String(cost), firstByteMs: firstByteMs ?? Date.now() - started, durationMs: Date.now() - started,
            failoverCount: routeFailoverState.count, responseBodyObject: responseObject, responseBodyHash: hash.digest('hex'), completedAt: new Date()
          }).where(eq(requestLogs.id, log.id)))
          await bestEffort(recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: requestedModel, endpoint, status: 'success', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, affinityReused: affinityWasReused, affinityEligible: true, totalTokens: usage.totalTokens, cost, durationMs: Date.now() - started, failovers: routeFailoverState.count }))
          await settleAdmissions(usage.totalTokens, cost)
          // Redis admissions must be finalized before wallet/telemetry work.
          // Otherwise a downstream failure would enter the outer catch and
          // settle the same reservation a second time.
          if (!await settleWalletReservation(cost)) throw new Error('钱包结算失败')
          settled = true
          if (!await releaseTrackedChannel(lease)) throw new Error('无法释放渠道并发租约')
          await bestEffort(touchKeyCredential(event, key.id))
          await bestEffort(recordChannelSuccess(event, candidate.channel.id, candidate.channel.ownerKind === 'user' ? candidate.protocolBinding.id : undefined))
          await bestEffort(rememberAffinitySelection(event, affinityKey, candidate))
          return
        }
        const upstreamBuffer = prefetchedResponseBuffer || await readUpstreamBodyLimited(
          response,
          requestController,
          response.ok ? UPSTREAM_RESPONSE_LIMITS.standardBytes : UPSTREAM_RESPONSE_LIMITS.errorBytes,
          {
            idleTimeoutMs: candidate.channel.timeoutMs,
            label: response.ok ? 'Upstream response' : 'Upstream error response'
          }
        )
        await closeConnection()
        const usage = direct ? anthropicUsage(JSON.parse(upstreamBuffer.toString('utf8') || '{}')) : openAiUsage((JSON.parse(upstreamBuffer.toString('utf8') || '{}') as Record<string, unknown>).usage)
        const output = response.ok && !direct ? Buffer.from(JSON.stringify(openAiChatToAnthropic(JSON.parse(upstreamBuffer.toString('utf8')), requestedModel))) : response.ok ? upstreamBuffer : upstreamError(upstreamBuffer, response.status)
        assertUpstreamResponseSize(
          output.length,
          response.ok ? UPSTREAM_RESPONSE_LIMITS.standardBytes : UPSTREAM_RESPONSE_LIMITS.errorBytes,
          requestController,
          response.ok ? 'Upstream response' : 'Upstream error response'
        )
        const cost = supplyDecision.source === 'user_relay' ? 0 : await calculateCost(event, requestedModel, usageForBilling(usage), body, effectivePriceMultiplier(Number(group.priceMultiplier), Number(key.priceMultiplier), Number(candidate.channel.priceMultiplier)))
        const responseObject = await storeBodySafe(event, requestId, 'response', output, 'application/json')
        await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: response.ok ? 'success' : 'failed', httpStatus: response.status, durationMs: Date.now() - started, failureClass: response.ok ? null : classifyRelayFailure(response.status, output.toString('utf8')), ...resourceFields(candidate) }))
        await bestEffort(useDatabase(event).update(requestLogs).set({
          channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, outboundProtocol: candidate.protocolBinding.protocol, conversionMode: candidate.conversionMode,
          sourceOwnerKind: candidate.channel.ownerKind, sourceOwnerUserId: candidate.channel.ownerUserId, cacheAffinityReused: affinityWasReused,
          ...resourceFields(candidate),
          upstreamModel: candidate.upstreamModel, status: response.ok ? 'success' : 'error', httpStatus: response.status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, reasoningTokens: usage.reasoningTokens, totalTokens: usage.totalTokens,
          cost: String(cost), billableTokens: usage.totalTokens, billedAmount: String(cost), firstByteMs: Date.now() - started, durationMs: Date.now() - started,
          failoverCount: routeFailoverState.count, responseBodyObject: responseObject, responseBodyHash: contentHash(output), errorMessage: response.ok ? null : redactSensitiveText(output.toString('utf8'), 2000), completedAt: new Date()
        }).where(eq(requestLogs.id, log.id)))
        await bestEffort(recordUsageRollups(event, { keyId: key.id, userId, groupId: group.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, protocol: candidate.protocolBinding.protocol, model: requestedModel, endpoint, status: response.ok ? 'success' : 'error', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, cacheCreationTokens: usage.cacheCreationTokens, affinityReused: affinityWasReused, affinityEligible: true, totalTokens: usage.totalTokens, cost, durationMs: Date.now() - started, failovers: routeFailoverState.count }))
        await settleAdmissions(usage.totalTokens, cost)
        if (!await settleWalletReservation(cost)) throw new Error('钱包结算失败')
        settled = true
        if (!await releaseTrackedChannel(lease)) throw new Error('无法释放渠道并发租约')
        await bestEffort(touchKeyCredential(event, key.id))
        if (response.ok) {
          await bestEffort(recordChannelSuccess(event, candidate.channel.id, candidate.channel.ownerKind === 'user' ? candidate.protocolBinding.id : undefined))
          await bestEffort(rememberAffinitySelection(event, affinityKey, candidate))
        }
        else {
          const failureText = output.toString('utf8').slice(0, 2000)
          const failureClass = classifyRelayFailure(response.status, failureText)
          if (candidate.channel.ownerKind === 'user') await bestEffort(markUserRelayFailure(event, candidate.channel.id, failureClass, failureText))
          if (relayFailureAffectsAccount(failureClass)) await bestEffort(recordChannelFailure(event, candidate.channel.id, `HTTP ${response.status}`))
        }
        setResponseStatus(event, response.status)
        setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
        setResponseHeader(event, 'x-request-id', requestId)
        return output
      } catch (error) {
        if (upstreamTimer) clearTimeout(upstreamTimer)
        await closeConnection()
        if (!await releaseTrackedChannel(lease)) throw new Error('无法释放渠道并发租约')
        const localStatus = Number((error as { statusCode?: number }).statusCode || 0)
        if (attempts === 0 && localStatus >= 400 && localStatus < 500) throw error
        await bestEffort(recordChannelFailure(event, candidate.channel.id, error instanceof Error ? error.message : 'upstream error'))
        await bestEffort(useDatabase(event).insert(requestAttempts).values({ requestLogId: log.id, channelId: candidate.channel.id, protocolBindingId: candidate.protocolBinding.id, attempt: attempts, status: 'failed', durationMs: Date.now() - started, errorMessage: redactSensitiveText(error instanceof Error ? error.message : 'Unknown upstream error', 2000), failureClass: 'upstream_unavailable', ...resourceFields(candidate) }))
        if (responseStarted) {
          const message = redactSensitiveText(error instanceof Error ? error.message : 'Upstream stream failed', 500)
          if (!event.node.res.destroyed && !event.node.res.writableEnded) {
            await writeResponseChunk(event.node.res, Buffer.from(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`)).catch(() => false)
            if (!event.node.res.writableEnded) event.node.res.end()
          }
          await bestEffort(useDatabase(event).update(requestLogs).set({
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
            failoverCount: routeFailoverState.count,
            completedAt: new Date()
          }).where(eq(requestLogs.id, log.id)))
          try {
            await settleAdmissions(0, 0)
          } catch (settlementError) {
            // Do not claim the admission was settled when Redis failed. Let
            // the outer cleanup retry through the idempotent Redis script.
            throw settlementError
          }
          if (walletHeld && walletHoldKey) {
            if (walletSettlementCost !== null) {
              if (!await settleWalletReservation(walletSettlementCost)) throw new Error('钱包结算失败')
            } else {
              if (!await bestEffort(releaseUserWallet(event, userId, walletHoldKey, `request:${requestId}:release`, requestId))) throw new Error('无法释放钱包冻结')
              walletHeld = false
            }
          }
          settled = true
          return
        }
        if (index === candidates.length - 1) throw error
      } finally {
        if (streamArchive && !streamArchive.destroyed) streamArchive.destroy()
        if (streamDirectory) await rm(streamDirectory, { recursive: true, force: true }).catch(() => {})
      }
    }
    anthropicError(503, 'All matching channels are at their concurrency limit', 'overloaded_error')
  } catch (error) {
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
      ...(lastCandidate ? resourceFields(lastCandidate) : {}),
      status: 'error', httpStatus, errorMessage: message, durationMs: Date.now() - startedAt, failoverCount: routeFailoverState.count, completedAt: new Date()
    }).where(eq(requestLogs.id, log.id)))
    await bestEffort(recordUsageRollups(event, {
      keyId: key.id,
      userId,
      groupId: group.id,
      channelId: lastCandidate?.channel.id || null,
      protocolBindingId: lastCandidate?.protocolBinding.id || null,
      protocol: lastCandidate?.protocolBinding.protocol || null,
      model: requestedModel,
      endpoint,
      status: 'error',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      durationMs: Date.now() - startedAt,
      failovers: routeFailoverState.count
    }))
    throw error
  }
}
