export type ChannelType = 'cpa' | 'sub2api' | 'openai_compatible' | 'anthropic_compatible'
export type ChannelOwnerKind = 'platform' | 'user'
export type ChannelAccessScope = 'all' | 'restricted' | 'private'
export type ChannelProtocol = 'anthropic_messages' | 'openai_responses' | 'openai_chat'
export type ChannelAuthScheme = 'bearer' | 'x_api_key'
export type ChannelClientIdentityMode = 'standard' | 'passthrough'
export type ProtocolVerificationStatus = 'unknown' | 'verified' | 'failed'
export type KeyRouteMode = 'platform_only' | 'private_only' | 'platform_then_private' | 'private_then_platform'
export type RoutingStrategy = 'priority' | 'weighted_round_robin'
export type HubKeyStatus = 'active' | 'disabled' | 'expired'

export interface AdminSessionView {
  authenticated: boolean
  user: { id: string; username: string; role: 'super_admin' | 'admin' | 'operator' | 'auditor' | 'user'; mustChangePassword?: boolean } | null
}

export interface ChannelView {
  id: string
  name: string
  type: ChannelType
  ownerKind: ChannelOwnerKind
  ownerUserId: string | null
  ownerUserName: string | null
  accessScope: ChannelAccessScope
  grantedUserIds: string[]
  grantedGroupIds: string[]
  baseUrl: string
  enabled: boolean
  priority: number
  weight: number
  maxConcurrency: number
  timeoutMs: number
  priceMultiplier: number
  healthStatus: string
  circuitState: 'closed' | 'open' | 'half_open'
  lastHealthCheckAt: number | null
  lastHealthError: string | null
  checkinEnabled: boolean
  modelDiscoveryEnabled: boolean
  clientIdentityMode: ChannelClientIdentityMode
  checkinConfigured: boolean
  checkinUserId: string | null
  lastCheckinAt: number | null
  lastCheckinStatus: string | null
  lastCheckinMessage: string | null
  balance: { quota: number | null; usedQuota: number | null; remaining: number | null; currency: string | null; fetchedAt: number } | null
  protocols: ChannelProtocolBindingView[]
  models: ChannelModelView[]
  cache: ChannelCacheView
  createdAt: number
  updatedAt: number
}

export interface ChannelCacheSliceView {
  label: string
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  tokenHitRate: number | null
  requestHitRate: number | null
  affinityReuseRate: number | null
  affinityFailovers: number
}

export interface ChannelCacheView extends ChannelCacheSliceView {
  protocols: ChannelCacheSliceView[]
  models: ChannelCacheSliceView[]
}

export interface ChannelProtocolBindingView {
  id?: string
  protocol: ChannelProtocol
  enabled: boolean
  baseUrlOverride: string | null
  authScheme: ChannelAuthScheme
  apiVersion: string | null
  verificationStatus: ProtocolVerificationStatus
  verifiedAt: number | null
  lastError: string | null
}

export interface ChannelModelView {
  id?: string
  publicModel: string
  upstreamModel: string
  enabled: boolean
  endpoints: string[]
  protocolBindings?: ChannelModelProtocolView[]
}

export interface ChannelModelProtocolView {
  id?: string
  protocol: ChannelProtocol
  upstreamModel: string
  enabled: boolean
  capabilities: Record<string, boolean>
}

export interface HubKeyView {
  id: string
  name: string
  note: string | null
  maskedKey: string
  revealable: boolean
  ownerUserId: string | null
  ownerUserName: string | null
  groupId: string | null
  groupName: string | null
  status: HubKeyStatus
  routeMode: KeyRouteMode
  channelIds: string[]
  expiresAt: number | null
  allowedEndpoints: string[]
  allowedModels: string[]
  rpmLimit: number | null
  concurrencyLimit: number | null
  totalRequestLimit: number | null
  totalTokenLimit: number | null
  totalCostLimit: number | null
  dailyRequestLimit: number | null
  dailyTokenLimit: number | null
  dailyCostLimit: number | null
  weeklyRequestLimit: number | null
  weeklyTokenLimit: number | null
  weeklyCostLimit: number | null
  monthlyRequestLimit: number | null
  monthlyTokenLimit: number | null
  monthlyCostLimit: number | null
  maxRequestTokens: number | null
  maxRequestCost: number | null
  maxImageCount: number | null
  allowedImageSizes: string[]
  allowedImageQualities: string[]
  priceMultiplier: number
  lastUsedAt: number | null
  createdAt: number
}

export interface HubKeyUsagePeriod {
  id: 'all' | 'today' | 'week' | 'month'
  requests: number
  admittedRequests: number
  tokens: number
  cost: number
  successRate: number | null
}

export interface HubKeyDetailView {
  item: HubKeyView
  credentials: HubKeyCredentialView[]
  periods: HubKeyUsagePeriod[]
  recentRequests: RequestLogView[]
}

export interface HubKeyCredentialView {
  id: string
  maskedKey: string
  status: 'active' | 'expired' | 'revoked'
  expiresAt: number | null
  lastUsedAt: number | null
  createdAt: number
  current: boolean
  revealable: boolean
}

export interface KeyActivityBucket {
  timestamp: number
  endTimestamp: number
  label: string
  requests: number
  tokens: number
  cost: number
  failures: number
}

export interface KeyActivityResponse {
  timezone: string
  from: number
  to: number
  generatedAt: number
  activeCount: number
  recentlyActiveCount: number
  buckets: Array<{ timestamp: number; endTimestamp: number; label: string }>
  keys: Array<{
    id: string
    name: string
    maskedKey: string
    status: HubKeyStatus
    requests: number
    successes: number
    failures: number
    pending: number
    tokens: number
    cost: number
    lastSeenAt: number | null
    recentlyActive: boolean
    buckets: KeyActivityBucket[]
  }>
}

export interface HubOverview {
  range: { from: number; to: number; preset: string }
  totals: {
    requests: number
    successes: number
    failures: number
    totalTokens: number
    cost: number
    averageLatencyMs: number | null
    p95LatencyMs: number | null
    p95FirstByteMs: number | null
    streamAbortRate: number | null
    successRate: number | null
    failovers: number
    cacheReadTokens: number
    cacheCreationTokens: number
    tokenCacheHitRate: number | null
    requestCacheHitRate: number | null
    affinityReuseRate: number | null
    affinityFailovers: number
  }
  timeline: Array<{ timestamp: number; requests: number; tokens: number; cost: number; failures: number }>
  models: Array<{ model: string; requests: number; tokens: number; cost: number }>
  endpoints: Array<{ endpoint: string; requests: number; failures: number; cost: number }>
  channels: Array<{ id: string; name: string; requests: number; failures: number; cost: number }>
  keys: Array<{ id: string; name: string; requests: number; tokens: number; cost: number }>
  statuses: Array<{ status: string; requests: number; cost: number }>
  users: Array<{ id: string; name: string; requests: number; tokens: number; cost: number }>
  groups: Array<{ id: string; name: string; requests: number; tokens: number; cost: number }>
  activeKeys: number
  activeUsers: number
  activeGroups: number
  healthyChannels: number
}

export interface RequestLogView {
  id: string
  requestId: string
  keyId: string | null
  keyName: string | null
  endpoint: string
  requestedModel: string | null
  upstreamModel: string | null
  channelId: string | null
  channelName: string | null
  status: string
  httpStatus: number | null
  totalTokens: number
  cost: number
  firstByteMs: number | null
  durationMs: number | null
  streaming: boolean
  errorMessage: string | null
  createdAt: number
}
