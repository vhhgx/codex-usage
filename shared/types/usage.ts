export type UsageRange = 'today' | '7d' | '30d'

export interface UserUsageSummary {
  calls: number
  successCalls: number
  failedCalls: number
  successRate: number
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
  successCalls: number
  failedCalls: number
  successRate: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
  estimatedCost: number
}

export interface UserUsageResponse {
  range: UsageRange
  from: number
  to: number
  summary: UserUsageSummary
  timeline: UserUsageTimelinePoint[]
  models: UserUsageModelRow[]
  generatedAt: number
}
