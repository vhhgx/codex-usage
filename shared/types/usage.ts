export type UsageRange = 'today' | '7d' | '30d'
export type UsageSource = 'cpa' | 'sub2api'

export type UserQuotaMode = 'quota_limited' | 'subscription' | 'balance'

export interface UserQuotaLimit {
  id: string
  label: string
  used: number
  limit: number
  remaining: number
  resetAt: number | null
}

export interface UserQuotaSummary {
  mode: UserQuotaMode
  isValid: boolean
  status: string
  planName: string
  unit: string
  remaining: number | null
  balance: number | null
  expiresAt: number | null
  daysUntilExpiry: number | null
  limits: UserQuotaLimit[]
}

export interface UserUsageSummary {
  calls: number
  successCalls: number | null
  failedCalls: number | null
  successRate: number | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
  estimatedCost: number
  averageLatencyMs: number | null
}

export interface UserUsageTimelinePoint {
  timestamp: number
  label: string
  calls: number
  totalTokens: number
  estimatedCost: number
  successRate: number | null
}

export interface UserUsageModelRow {
  model: string
  calls: number
  successCalls: number | null
  failedCalls: number | null
  successRate: number | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
  estimatedCost: number
}

export interface UserUsageResponse {
  source: UsageSource
  range: UsageRange
  from: number
  to: number
  summary: UserUsageSummary
  timeline: UserUsageTimelinePoint[]
  models: UserUsageModelRow[]
  quota?: UserQuotaSummary
  generatedAt: number
}
