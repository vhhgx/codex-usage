export type UpstreamConnectionId = 'cpa' | 'sub2api'
export type UpstreamOperationStatus = 'pending' | 'succeeded' | 'failed' | 'reconciliation_required'

export interface UpstreamConnectionView {
  id: UpstreamConnectionId
  name: string
  configured: boolean
  baseUrl: string | null
  capabilities: string[]
}

export interface CpaAuthFileView {
  id: string
  name: string
  provider: string
  account: string | null
  planType: string | null
  status: string
  statusMessage: string | null
  disabled: boolean
  lastRefreshAt: number | null
}

export interface SubAccountManagementView {
  id: string
  name: string
  email?: string | null
  notes: string | null
  platform: string
  type: string
  status: string
  schedulable: boolean
  priority: number
  concurrency: number
  currentConcurrency: number
  rateMultiplier: number
  groupIds: string[]
  groupNames: string[]
  proxyId: string | null
  proxyName: string | null
  proxyFallbackOriginId: string | null
  proxyEditable: boolean
  expiresAt: number | null
  errorMessage: string | null
  updatedAt: number | null
}

export type SubProxyProtocol = 'http' | 'https' | 'socks5' | 'socks5h'

export interface SubProxyView {
  id: string
  name: string
  protocol: SubProxyProtocol
  host: string
  port: number
  username: string | null
  hasPassword: boolean
  status: string
  expiresAt: number | null
  fallbackMode: string
  backupProxyId: string | null
  backupProxyName: string | null
  expiryWarnDays: number
  accountCount: number
  latencyMs: number | null
  qualityScore: number | null
  lastCheckedAt: number | null
  errorMessage: string | null
}

export type CpaProxyMode = 'pool' | 'direct' | 'custom' | 'unavailable' | 'error'

export interface ProxyPoolState {
  proxies: SubProxyView[]
  defaultProxyId: string | null
  cpaDefaultProxyId: string | null
  cpaProxyMode: CpaProxyMode
}

export interface SubGroupView {
  id: string
  name: string
  description: string | null
  platform: string
  status: string
  subscriptionType: string | null
  rateMultiplier: number
  dailyLimit: number | null
  weeklyLimit: number | null
  monthlyLimit: number | null
  rpmLimit: number | null
  allowImage: boolean
  allowVideo: boolean
  fallbackGroupId: string | null
  fallbackGroupName: string | null
  invalidFallbackGroupId: string | null
  invalidFallbackGroupName: string | null
  accountCount: number
  policy: Record<string, unknown>
  updatedAt: number | null
}

export interface UpstreamOperationView {
  id: string
  requestId: string
  connectionId: string
  action: string
  targetType: string
  targetRef: string | null
  status: UpstreamOperationStatus
  upstreamStatus: number | null
  safeSummary: Record<string, unknown>
  errorMessage: string | null
  startedAt: number
  completedAt: number | null
}
