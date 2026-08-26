import type { ChannelAuthScheme, ChannelProtocol, RelayPlatformType } from '#shared/types/hub'
import { redactSensitiveText } from '../utils/upstream'

type UnknownRecord = Record<string, unknown>

export interface RelayPlatformDefinition {
  id: RelayPlatformType
  label: string
  supportsBalance: boolean
  supportsCheckin: boolean
  requiresConsoleToken: boolean
  defaultAuth(protocol: ChannelProtocol): ChannelAuthScheme
}

const definitions: Record<RelayPlatformType, RelayPlatformDefinition> = {
  generic: {
    id: 'generic', label: '通用兼容站', supportsBalance: false, supportsCheckin: false, requiresConsoleToken: false,
    defaultAuth: protocol => protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer'
  },
  newapi: {
    id: 'newapi', label: 'NewAPI', supportsBalance: true, supportsCheckin: true, requiresConsoleToken: true,
    defaultAuth: () => 'bearer'
  },
  sub2api: {
    id: 'sub2api', label: 'Sub2API', supportsBalance: true, supportsCheckin: false, requiresConsoleToken: false,
    defaultAuth: () => 'bearer'
  }
}

export function relayPlatform(value: unknown): RelayPlatformType {
  return value === 'newapi' || value === 'sub2api' ? value : 'generic'
}

export function relayPlatformDefinition(value: unknown) {
  return definitions[relayPlatform(value)]
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function numeric(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export interface RelayBalanceValues {
  totalQuota: number | null
  purchasedQuota: number | null
  giftQuota: number | null
  usedQuota: number | null
  remainingBalance: number | null
  currency: string | null
  source: string
}

export function parseNewApiBalance(payload: unknown): RelayBalanceValues {
  const root = record(payload)
  const data = record(root.data)
  const nested = record(data.data)
  const source = Object.keys(nested).length ? nested : data
  const purchased = numeric(source.quota ?? source.purchased_quota ?? source.purchase_quota)
  const gift = numeric(source.gift_quota ?? source.giftQuota)
  const explicitTotal = numeric(source.total_quota ?? source.totalQuota)
  const total = explicitTotal ?? (purchased !== null && gift !== null ? purchased + gift : purchased ?? numeric(source.unlimited_quota))
  const used = numeric(source.used_quota ?? source.usedQuota)
  const ratio = 500_000
  return {
    totalQuota: total === null ? null : total / ratio,
    purchasedQuota: purchased === null ? null : purchased / ratio,
    giftQuota: gift === null ? null : gift / ratio,
    usedQuota: used === null ? null : used / ratio,
    remainingBalance: total === null ? null : total / ratio,
    currency: typeof source.currency === 'string' && source.currency.trim() ? source.currency.trim() : 'CNY',
    source: 'newapi_self'
  }
}

export function parseSub2ApiBalance(payload: unknown): RelayBalanceValues {
  const root = record(payload)
  const data = Object.keys(record(root.data)).length ? record(root.data) : root
  const quota = record(data.quota)
  const balance = numeric(data.balance ?? data.remaining ?? quota.remaining)
  const limit = numeric(quota.limit ?? data.quota_limit)
  const used = numeric(quota.used ?? data.used ?? data.used_quota)
  return {
    totalQuota: limit,
    purchasedQuota: null,
    giftQuota: null,
    usedQuota: used,
    remainingBalance: balance ?? (limit !== null && used !== null ? Math.max(0, limit - used) : null),
    currency: typeof data.currency === 'string' && data.currency.trim() ? data.currency.trim() : 'USD',
    source: 'sub2api_usage'
  }
}

export type RelayFailureClass = 'quota_exhausted' | 'rate_limited' | 'credential_error' | 'model_denied' | 'model_missing' | 'upstream_unavailable' | 'client_error' | 'unknown'

export function classifyRelayFailure(status: number | null, body: string): RelayFailureClass {
  const safe = redactSensitiveText(body).toLowerCase()
  let code = ''
  try {
    const payload = record(JSON.parse(body))
    const error = record(payload.error)
    code = String(error.code ?? error.type ?? payload.code ?? payload.type ?? '').toLowerCase()
  } catch {}
  const combined = `${code} ${safe}`
  if (/insufficient[_ -]?quota|quota[_ -]?exhausted|余额不足|额度(?:不足|耗尽)|credit balance.*(?:low|empty|exhausted)/i.test(combined)) return 'quota_exhausted'
  if (status === 429) return 'rate_limited'
  if (status === 401 || /invalid[_ -]?(?:api[_ -]?)?key|unauthenticated|authentication_error/i.test(combined)) return 'credential_error'
  if (status === 403) return 'model_denied'
  if (status === 404 || /model.*(?:not found|does not exist)|unknown model/i.test(combined)) return 'model_missing'
  if (status !== null && status >= 500) return 'upstream_unavailable'
  if (status !== null && status >= 400 && status < 500) return 'client_error'
  return 'unknown'
}

export function relayFailureAllowsFailover(status: number, failureClass: RelayFailureClass, privateRelay: boolean) {
  if ([429, 500, 502, 503, 504].includes(status)) return true
  if (!privateRelay) return false
  return failureClass === 'quota_exhausted'
    || failureClass === 'credential_error'
    || failureClass === 'model_denied'
    || failureClass === 'model_missing'
    || failureClass === 'upstream_unavailable'
}

export function relayFailureAffectsAccount(failureClass: RelayFailureClass) {
  return failureClass === 'quota_exhausted'
    || failureClass === 'credential_error'
    || failureClass === 'rate_limited'
    || failureClass === 'upstream_unavailable'
}
