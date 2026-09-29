import { and, asc, count, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { useDatabase } from '../db'
import { channelModelBindings, channelModels, channelProtocolBindings, channels, probeModelCatalog } from '../db/schema'
import { useRedis } from '../utils/redis'
import { decryptChannelSecret } from '../utils/hub-crypto'
import { isClientIdentityRejection, upstreamAuthHeaders } from '../utils/upstream-auth'
import { upstreamProbeClientIdentity } from '../utils/upstream-client-identity'
import { redactSensitiveText } from '../utils/upstream'
import type { ChannelAuthScheme, ChannelProtocol, ProtocolVerificationStatus, RelayCapabilityMode } from '#shared/types/hub'

// 探测任务状态
export interface ProbeTask {
  taskId: string
  channelId: string
  channelName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  progress: {
    current: number
    total: number
    currentProtocol?: string
  }
  results: {
    protocol: string
    status: 'success' | 'failed' | 'pending'
    testedModel?: string
    failureClass?: ProbeFailureClass
    error?: string
  }[]
}

/**
 * Probe outcomes intentionally separate concerns that used to collapse into a
 * single "failed" verdict:
 * - `supported`                 端点存在且接受了该协议（可能只是参数级报错）
 * - `unsupported_endpoint`      该协议端点不存在 / 方法不支持
 * - `model_missing`             端点存在，但探测模型在上游不存在
 * - `credential_error`          凭据无效或被拒
 * - `client_identity_required`  需要特定客户端身份头
 * - `incompatible`              端点返回 2xx 但不是该协议的结构
 * - `rate_limited`              被限流（端点与协议可用）
 * - `upstream_error`            上游 5xx / 超时
 * - `network_error`             连接失败
 */
export type ProbeFailureClass =
  | 'supported'
  | 'unsupported_endpoint'
  | 'model_missing'
  | 'credential_error'
  | 'client_identity_required'
  | 'incompatible'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'

const PROBE_PROTOCOLS: ChannelProtocol[] = ['anthropic_messages', 'openai_chat', 'openai_responses']
const DEFAULT_PROBE_TIMEOUT_MS = 15_000

function defaultAuthScheme(protocol: ChannelProtocol): ChannelAuthScheme {
  return protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer'
}

function responseMatchesProtocol(protocol: ChannelProtocol, text: string) {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return false }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const payload = parsed as Record<string, unknown>
  if (protocol === 'openai_chat') return Array.isArray(payload.choices) || payload.object === 'chat.completion'
  if (protocol === 'openai_responses') {
    return payload.object === 'response' || Array.isArray(payload.output)
  }
  return payload.type === 'message' || Array.isArray(payload.content)
}

/**
 * Pure classifier so the response-code interpretation can be unit tested.
 * Deliberately treats a 400/422 as `supported`: the endpoint exists and parsed
 * the request far enough to reject a parameter. Only an explicit
 * endpoint/route signal downgrades it, which avoids marking a working channel
 * unusable because our probe body did not match.
 */
export function classifyProbeResponse(input: { protocol: ChannelProtocol; status: number; body: string }): ProbeFailureClass {
  const text = String(input.body || '').slice(0, 8000)
  const lower = text.toLowerCase()
  const modelMissing = /model[^，。；\n]{0,40}?(?:not[\s_-]*found|does[\s_-]*not[\s_-]*exist|unknown|invalid|unsupported)|unknown[\s_-]*model|模型[^，。；\n]{0,10}(?:不存在|无效|未找到|不支持)/.test(lower)
  const endpointMissing = /(?:unsupported|unknown|invalid|no[\s_-]*such|not[\s_-]*found)[\s_-]*(?:endpoint|route|path|url|api)|(?:endpoint|route|path)[\s_-]*(?:not[\s_-]*found|unsupported|does[\s_-]*not[\s_-]*exist)|<\s*!doctype\s+html|<\s*html[\s>]/.test(lower)

  if (input.status >= 200 && input.status < 300) {
    if (responseMatchesProtocol(input.protocol, text)) return 'supported'
    if (isClientIdentityRejection(text)) return 'client_identity_required'
    return 'incompatible'
  }
  if (input.status === 401 || input.status === 403) {
    if (isClientIdentityRejection(text)) return 'client_identity_required'
    return modelMissing ? 'model_missing' : 'credential_error'
  }
  if (input.status === 404) return modelMissing ? 'model_missing' : 'unsupported_endpoint'
  if (input.status === 405 || input.status === 501) return 'unsupported_endpoint'
  if (input.status === 429) return 'rate_limited'
  if (input.status >= 500) return 'upstream_error'
  if (input.status >= 400 && input.status < 500) {
    if (endpointMissing) return 'unsupported_endpoint'
    if (modelMissing) return 'model_missing'
    return 'supported'
  }
  return 'incompatible'
}

interface ProtocolProbeResult {
  protocol: ChannelProtocol
  failureClass: ProbeFailureClass
  testedModel: string | null
  status: number | null
  message: string
}

function probeSucceeded(result: ProbeFailureClass) {
  return result === 'supported' || result === 'rate_limited'
}

function probeVerification(result: ProtocolProbeResult): ProtocolVerificationStatus {
  if (probeSucceeded(result.failureClass)) return 'verified'
  if (result.failureClass === 'client_identity_required') return 'pending_real_client'
  return 'failed'
}

function probeCapability(result: ProtocolProbeResult): RelayCapabilityMode {
  if (result.failureClass === 'unsupported_endpoint') return 'unsupported'
  return 'native'
}

// 创建探测任务
export async function createProbeTask(
  event: H3Event,
  channelId: string,
  options: { ownerUserId?: string } = {}
): Promise<{ taskId: string }> {
  const db = useDatabase(event)

  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
  if (!channel) throw createError({ statusCode: 404, message: '渠道不存在' })

  // Callers acting on behalf of a user must scope the probe to their own relay.
  if (options.ownerUserId && !(channel.ownerKind === 'user' && channel.ownerUserId === options.ownerUserId)) {
    throw createError({ statusCode: 404, message: '渠道不存在' })
  }

  const taskId = `probe_${channelId}_${Date.now()}`
  const task: ProbeTask = {
    taskId,
    channelId,
    channelName: channel.name,
    status: 'pending',
    startedAt: Date.now(),
    progress: { current: 0, total: PROBE_PROTOCOLS.length },
    results: PROBE_PROTOCOLS.map(protocol => ({ protocol, status: 'pending' as const }))
  }

  const redis = useRedis(event)
  await redis.set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)

  runProbeTask(event, taskId, channel).catch(error => {
    console.error(`[probe-task] ${taskId} failed:`, error)
  })

  return { taskId }
}

// 获取任务状态
export async function getProbeTask(event: H3Event, taskId: string): Promise<ProbeTask | null> {
  const redis = useRedis(event)
  const raw = await redis.get(`hub:probe-task:${taskId}`)
  if (!raw) return null
  return JSON.parse(raw) as ProbeTask
}

async function persistTask(event: H3Event, taskId: string, task: ProbeTask) {
  await useRedis(event).set(`hub:probe-task:${taskId}`, JSON.stringify(task), 'EX', 3600)
}

// 执行探测任务（后台运行）
async function runProbeTask(event: H3Event, taskId: string, channel: typeof channels.$inferSelect) {
  const task = await getProbeTask(event, taskId)
  if (!task) return
  task.status = 'running'
  await persistTask(event, taskId, task)

  const db = useDatabase(event)
  const existingBindings = await db.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channel.id))
  const results: ProtocolProbeResult[] = []

  for (const [index, protocol] of PROBE_PROTOCOLS.entries()) {
    task.progress.current = index
    task.progress.currentProtocol = protocol
    await persistTask(event, taskId, task)

    const binding = existingBindings.find(item => item.protocol === protocol)
    let result: ProtocolProbeResult
    try {
      result = await probeProtocol(event, channel, protocol, binding ? {
        authScheme: binding.authScheme,
        apiVersion: binding.apiVersion,
        baseUrlOverride: binding.baseUrlOverride
      } : {
        authScheme: defaultAuthScheme(protocol),
        apiVersion: protocol === 'anthropic_messages' ? '2023-06-01' : null,
        baseUrlOverride: null
      })
    } catch (error) {
      result = {
        protocol,
        failureClass: 'network_error',
        testedModel: null,
        status: null,
        message: error instanceof Error ? redactSensitiveText(error.message, 500) : '探测失败'
      }
    }
    results.push(result)
    task.results[index] = {
      protocol,
      status: probeSucceeded(result.failureClass) ? 'success' : 'failed',
      testedModel: result.testedModel || undefined,
      failureClass: result.failureClass,
      error: result.message || undefined
    }
    await persistTask(event, taskId, task)
  }

  const resultByProtocol = new Map(results.map(result => [result.protocol, result]))
  const chatResult = resultByProtocol.get('openai_chat')
  const responsesResult = resultByProtocol.get('openai_responses')
  // `/v1/responses` 不被支持但 `/v1/chat/completions` 可用时，替代能力挂在 chat 绑定上，
  // 由路由层的 capabilityMode 决定是否需要 responses→chat 转换。
  const responsesViaChat = Boolean(
    chatResult && probeSucceeded(chatResult.failureClass)
    && responsesResult && !probeSucceeded(responsesResult.failureClass)
  )

  // 只更新验证状态：绝不删除绑定、绝不改动 enabled/authScheme/baseUrlOverride，也不重建模型绑定。
  await db.transaction(async (tx) => {
    for (const protocol of PROBE_PROTOCOLS) {
      const result = resultByProtocol.get(protocol)!
      const current = existingBindings.find(item => item.protocol === protocol)
      const capabilityMode: RelayCapabilityMode = responsesViaChat && protocol === 'openai_chat'
        ? 'responses_via_chat'
        : probeCapability(result)
      const verificationStatus = probeVerification(result)
      const now = new Date()
      if (current) {
        await tx.update(channelProtocolBindings).set({
          verificationStatus,
          capabilityMode,
          verifiedAt: verificationStatus === 'verified' ? now : null,
          detectedAt: now,
          lastError: probeSucceeded(result.failureClass) ? null : result.message.slice(0, 500) || null,
          updatedAt: now
        }).where(eq(channelProtocolBindings.id, current.id))
        continue
      }
      // 只为真正可用的协议新建绑定行；失败的协议不写入，避免制造不可路由的噪音。
      if (!probeSucceeded(result.failureClass)) continue
      await tx.insert(channelProtocolBindings).values({
        channelId: channel.id,
        protocol,
        enabled: true,
        authScheme: defaultAuthScheme(protocol),
        apiVersion: protocol === 'anthropic_messages' ? '2023-06-01' : null,
        verificationStatus,
        capabilityMode,
        verifiedAt: now,
        detectedAt: now
      })
    }

    // 修复历史上被破坏性探测清空的模型绑定：仅当渠道完全没有模型绑定时补齐。
    const [bindingCount] = await tx.select({ value: count() }).from(channelModelBindings)
      .innerJoin(channelModels, eq(channelModelBindings.channelModelId, channelModels.id))
      .where(eq(channelModels.channelId, channel.id))
    if (Number(bindingCount?.value || 0) === 0) {
      const models = await tx.select({ id: channelModels.id, upstreamModel: channelModels.upstreamModel }).from(channelModels).where(eq(channelModels.channelId, channel.id))
      const protocols = await tx.select().from(channelProtocolBindings).where(eq(channelProtocolBindings.channelId, channel.id))
      const routableProtocols = protocols.filter(protocol => protocol.enabled && protocol.verificationStatus !== 'failed')
      const rows = models.flatMap(model => routableProtocols.map(protocol => ({
        channelModelId: model.id,
        protocolBindingId: protocol.id,
        upstreamModel: model.upstreamModel,
        capabilities: { streaming: true, tools: true } as Record<string, boolean>,
        enabled: true
      })))
      if (rows.length) await tx.insert(channelModelBindings).values(rows).onConflictDoNothing()
    }
  })

  task.status = 'completed'
  task.completedAt = Date.now()
  task.progress.current = PROBE_PROTOCOLS.length
  await persistTask(event, taskId, task)
}

async function probeProtocol(
  event: H3Event,
  channel: typeof channels.$inferSelect,
  protocol: ChannelProtocol,
  binding: { authScheme: ChannelAuthScheme; apiVersion: string | null; baseUrlOverride: string | null }
): Promise<ProtocolProbeResult> {
  const db = useDatabase(event)
  const probeModels = await db.select().from(probeModelCatalog)
    .where(and(eq(probeModelCatalog.protocol, protocol), eq(probeModelCatalog.enabled, true)))
    .orderBy(asc(probeModelCatalog.sortOrder))
  if (!probeModels.length) {
    return { protocol, failureClass: 'incompatible', testedModel: null, status: null, message: '没有配置探测模型，请在探测模型目录中添加' }
  }

  const baseUrl = (binding.baseUrlOverride || channel.baseUrl).replace(/\/+$/, '')
  const apiKey = decryptChannelSecret(channel.encryptedApiKey, channel.id, channel.ownerKind, event)
  const timeoutMs = Math.min(Math.max(channel.timeoutMs, 1000), DEFAULT_PROBE_TIMEOUT_MS)
  const identityHeaders = channel.clientIdentityMode === 'passthrough' ? upstreamProbeClientIdentity(protocol) : {}

  let lastModelMissing: ProtocolProbeResult | null = null
  for (const probeModel of probeModels) {
    let response: { status: number; body: string }
    try {
      response = await requestProtocol(baseUrl, apiKey, binding, protocol, probeModel.model, timeoutMs, identityHeaders)
    } catch (error) {
      return {
        protocol,
        failureClass: 'network_error',
        testedModel: probeModel.model,
        status: null,
        message: error instanceof Error ? redactSensitiveText(error.message, 500) : '无法连接上游'
      }
    }
    const failureClass = classifyProbeResponse({ protocol, status: response.status, body: response.body })
    const message = failureClass === 'supported'
      ? ''
      : `HTTP ${response.status}: ${redactSensitiveText(response.body, 300)}`
    if (failureClass === 'model_missing') {
      lastModelMissing = { protocol, failureClass, testedModel: probeModel.model, status: response.status, message }
      continue
    }
    // 端点级/凭据级/限流/上游错误都与模型无关，立即停止换模型。
    return { protocol, failureClass, testedModel: probeModel.model, status: response.status, message }
  }
  return lastModelMissing || {
    protocol,
    failureClass: 'model_missing',
    testedModel: null,
    status: null,
    message: '探测模型目录中的模型在上游均不存在'
  }
}

function protocolRequestConfig(protocol: ChannelProtocol, model: string) {
  if (protocol === 'anthropic_messages') {
    return {
      endpoint: '/v1/messages',
      body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
    }
  }
  if (protocol === 'openai_responses') {
    return {
      endpoint: '/v1/responses',
      body: { model, input: 'ping', max_output_tokens: 16 }
    }
  }
  return {
    endpoint: '/v1/chat/completions',
    body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
  }
}

async function requestProtocol(
  baseUrl: string,
  apiKey: string,
  binding: { authScheme: ChannelAuthScheme; apiVersion: string | null },
  protocol: ChannelProtocol,
  model: string,
  timeoutMs: number,
  identityHeaders: Record<string, string>
) {
  const config = protocolRequestConfig(protocol, model)
  const response = await fetch(`${baseUrl}${config.endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...upstreamAuthHeaders(binding.authScheme, apiKey, binding.apiVersion),
      ...identityHeaders
    },
    body: JSON.stringify(config.body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  return { status: response.status, body: await response.text() }
}
