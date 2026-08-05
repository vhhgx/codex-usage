import type { H3Event } from 'h3'
import { resolveSub2ApiGroupIds, resolveSub2ApiProxySelection } from './sub2api-admin'

type UnknownRecord = Record<string, unknown>

function string(value: unknown, field: string, required = false, max = 500) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (required && !result) throw createError({ statusCode: 400, message: `${field} 不能为空` })
  if (result.length > max) throw createError({ statusCode: 400, message: `${field} 过长` })
  return result
}

function number(value: unknown, field: string, min = 0, max = 1_000_000) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw createError({ statusCode: 400, message: `${field} 超出有效范围` })
  return parsed
}

export async function accountImportPayload(event: H3Event, body: UnknownRecord, credentials: UnknownRecord) {
  const type = string(body.type, '账号类型', true, 40)
  if (!['oauth', 'setup-token', 'apikey', 'upstream', 'bedrock', 'service_account'].includes(type)) {
    throw createError({ statusCode: 400, message: '不支持的账号类型' })
  }
  return {
    name: string(body.name, '账号名称', true, 160),
    notes: string(body.notes, '备注', false, 1000) || null,
    platform: string(body.platform, '平台', true, 50),
    type,
    credentials,
    extra: body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra) ? body.extra : {},
    concurrency: number(body.concurrency ?? 1, '并发数', 1, 10_000),
    priority: number(body.priority ?? 0, '优先级', 0, 1_000_000),
    rate_multiplier: number(body.rateMultiplier ?? 1, '倍率', 0, 1000),
    group_ids: await resolveSub2ApiGroupIds(event, body.groupIds || []),
    proxy_id: await resolveSub2ApiProxySelection(event, body.proxyId, !Object.prototype.hasOwnProperty.call(body, 'proxyId')),
    expires_at: body.expiresAt ? Math.floor(number(body.expiresAt, '到期时间', 1, Number.MAX_SAFE_INTEGER) / (Number(body.expiresAt) > 1e12 ? 1000 : 1)) : null,
    auto_pause_on_expired: body.autoPauseOnExpired !== false,
    upstream_billing_probe_enabled: body.upstreamBillingProbeEnabled === true,
    confirm_mixed_channel_risk: body.confirmMixedChannelRisk === true
  }
}

export async function accountUpdatePayload(event: H3Event, body: UnknownRecord) {
  const out: UnknownRecord = {}
  if ('name' in body) out.name = string(body.name, '账号名称', true, 160)
  if ('notes' in body) out.notes = string(body.notes, '备注', false, 1000) || null
  if ('status' in body) {
    const status = string(body.status, '状态', true, 20)
    if (!['active', 'inactive', 'error'].includes(status)) throw createError({ statusCode: 400, message: '账号状态无效' })
    out.status = status
  }
  if ('concurrency' in body) out.concurrency = number(body.concurrency, '并发数', 1, 10_000)
  if ('priority' in body) out.priority = number(body.priority, '优先级', 0, 1_000_000)
  if ('rateMultiplier' in body) out.rate_multiplier = number(body.rateMultiplier, '倍率', 0, 1000)
  if ('groupIds' in body) out.group_ids = await resolveSub2ApiGroupIds(event, body.groupIds)
  if ('proxyId' in body) out.proxy_id = await resolveSub2ApiProxySelection(event, body.proxyId, false)
  if ('schedulable' in body) {
    if (typeof body.schedulable !== 'boolean') throw createError({ statusCode: 400, message: 'schedulable 必须是布尔值' })
    out.schedulable = body.schedulable
  }
  if (!Object.keys(out).length) throw createError({ statusCode: 400, message: '没有可更新的账号字段' })
  return out
}

const PROXY_PROTOCOLS = new Set(['http', 'https', 'socks5', 'socks5h'])

export async function proxyPayload(event: H3Event, body: UnknownRecord, create: boolean) {
  const out: UnknownRecord = {}
  if (create || 'name' in body) out.name = string(body.name, '代理名称', true, 160)
  if (create || 'protocol' in body) {
    const protocol = string(body.protocol, '代理协议', true, 20).toLowerCase()
    if (!PROXY_PROTOCOLS.has(protocol)) throw createError({ statusCode: 400, message: '代理协议无效' })
    out.protocol = protocol
  }
  if (create || 'host' in body) {
    const host = string(body.host, '代理主机', true, 255)
    if (/[:/]\/{2}|[/?#@]/.test(host)) throw createError({ statusCode: 400, message: '代理主机只填写域名或 IP，不要包含协议、路径或认证信息' })
    out.host = host
  }
  if (create || 'port' in body) out.port = number(body.port, '代理端口', 1, 65535)
  if ('username' in body || create) out.username = string(body.username, '代理用户名', false, 255) || ''
  if (typeof body.password === 'string' && body.password.length) {
    if (body.password.length > 1024) throw createError({ statusCode: 400, message: '代理密码过长' })
    out.password = body.password
  }
  if ('status' in body) {
    const status = string(body.status, '代理状态', true, 20)
    if (!['active', 'inactive'].includes(status)) throw createError({ statusCode: 400, message: '代理状态无效' })
    out.status = status
  }
  if ('expiresAt' in body || create) {
    if (body.expiresAt === null || body.expiresAt === '') out.expires_at = null
    else {
      const timestamp = typeof body.expiresAt === 'number' ? body.expiresAt : Date.parse(String(body.expiresAt))
      if (!Number.isFinite(timestamp)) throw createError({ statusCode: 400, message: '代理到期时间无效' })
      out.expires_at = new Date(timestamp).toISOString()
    }
  }
  if ('fallbackMode' in body || create) out.fallback_mode = string(body.fallbackMode, '回退模式', false, 40) || 'direct'
  if ('backupProxyId' in body || create) {
    out.backup_proxy_id = body.backupProxyId === null || body.backupProxyId === '' || body.backupProxyId === undefined
      ? null
      : await resolveSub2ApiProxySelection(event, body.backupProxyId, false, false)
  }
  if ('expiryWarnDays' in body || create) out.expiry_warn_days = number(body.expiryWarnDays ?? 7, '到期预警天数', 0, 365)
  return out
}

const GROUP_SCALARS: Record<string, [string, 'string' | 'number' | 'boolean']> = {
  description: ['description', 'string'], platform: ['platform', 'string'], status: ['status', 'string'],
  subscriptionType: ['subscription_type', 'string'], rateMultiplier: ['rate_multiplier', 'number'],
  dailyLimit: ['daily_limit_usd', 'number'], weeklyLimit: ['weekly_limit_usd', 'number'], monthlyLimit: ['monthly_limit_usd', 'number'],
  rpmLimit: ['rpm_limit', 'number'], isExclusive: ['is_exclusive', 'boolean'],
  allowImage: ['allow_image_generation', 'boolean'], allowBatchImage: ['allow_batch_image_generation', 'boolean'],
  imageRateIndependent: ['image_rate_independent', 'boolean'], imageRateMultiplier: ['image_rate_multiplier', 'number'],
  batchImageDiscountMultiplier: ['batch_image_discount_multiplier', 'number'], batchImageHoldMultiplier: ['batch_image_hold_multiplier', 'number'],
  videoRateIndependent: ['video_rate_independent', 'boolean'], videoRateMultiplier: ['video_rate_multiplier', 'number'],
  peakRateEnabled: ['peak_rate_enabled', 'boolean'], peakStart: ['peak_start', 'string'], peakEnd: ['peak_end', 'string'],
  peakRateMultiplier: ['peak_rate_multiplier', 'number'], imagePrice1K: ['image_price_1k', 'number'],
  imagePrice2K: ['image_price_2k', 'number'], imagePrice4K: ['image_price_4k', 'number'],
  videoPrice480P: ['video_price_480p', 'number'], videoPrice720P: ['video_price_720p', 'number'],
  videoPrice1080P: ['video_price_1080p', 'number'], webSearchPricePerCall: ['web_search_price_per_call', 'number'],
  claudeCodeOnly: ['claude_code_only', 'boolean'], mcpXmlInject: ['mcp_xml_inject', 'boolean'],
  allowMessagesDispatch: ['allow_messages_dispatch', 'boolean'], allowLive: ['allow_live', 'boolean'],
  requireOAuthOnly: ['require_oauth_only', 'boolean'], requirePrivacySet: ['require_privacy_set', 'boolean'],
  defaultMappedModel: ['default_mapped_model', 'string'], maxReasoningEffort: ['max_reasoning_effort', 'string']
}

export async function groupPayload(event: H3Event, body: UnknownRecord, create: boolean) {
  const out: UnknownRecord = {}
  if (create || 'name' in body) out.name = string(body.name, '分组名称', true, 160)
  for (const [input, [upstream, kind]] of Object.entries(GROUP_SCALARS)) {
    if (!(input in body)) continue
    const value = body[input]
    if (value === null && kind === 'number') { out[upstream] = -1; continue }
    if (kind === 'string') out[upstream] = string(value, input, false, 500)
    if (kind === 'number') out[upstream] = number(value, input, 0, 1_000_000)
    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw createError({ statusCode: 400, message: `${input} 必须是布尔值` })
      out[upstream] = value
    }
  }
  for (const [input, upstream] of [['fallbackGroupId', 'fallback_group_id'], ['invalidFallbackGroupId', 'fallback_group_id_on_invalid_request']] as const) {
    if (!(input in body)) continue
    if (body[input] === null || body[input] === '') out[upstream] = null
    else out[upstream] = (await resolveSub2ApiGroupIds(event, [body[input]]))[0]
  }
  for (const [input, upstream] of [['supportedModelScopes', 'supported_model_scopes'], ['reasoningEffortMappings', 'reasoning_effort_mappings']] as const) {
    if (input in body) out[upstream] = body[input]
  }
  for (const [input, upstream] of [['messagesDispatchModelConfig', 'messages_dispatch_model_config'], ['modelsListConfig', 'models_list_config']] as const) {
    if (input in body && body[input] && typeof body[input] === 'object' && !Array.isArray(body[input])) out[upstream] = body[input]
  }
  if (create) {
    out.platform ||= 'openai'
    out.subscription_type ||= 'standard'
    out.rate_multiplier ??= 1
  }
  return out
}
