export interface Sub2ApiAccountView {
  id: string
  name: string
  email?: string | null
  notes: string | null
  platform: string
  accountType: string
  status: string
  schedulable: boolean
  errorMessage: string | null
  expiresAt: number | null
  concurrency: number
  currentConcurrency: number
}

export interface Sub2ApiAccountQuotaWindow {
  id: string
  label: string
  usedPercent: number | null
  remainingPercent: number | null
  used: number | null
  limit: number | null
  resetAt: number | null
  stats: Sub2ApiAccountWindowStats | null
}

export interface Sub2ApiAccountWindowStats {
  requests: number
  tokens: number
  cost: number
  standardCost: number | null
  userCost: number | null
}

export interface Sub2ApiAccountProbeError {
  code: number
  message: string
  reason: string | null
}

export interface Sub2ApiAccountQuotaResult extends Sub2ApiAccountView {
  quotaStatus: 'success' | 'error'
  planType: string | null
  windows: Sub2ApiAccountQuotaWindow[]
  refreshedAt: number
  usageSource: 'passive' | 'active'
  error?: string
  probeError?: Sub2ApiAccountProbeError
}

export interface Sub2ApiAccountsResponse {
  results: Sub2ApiAccountQuotaResult[]
  accountCount: number
  successCount: number
  failureCount: number
  generatedAt: number
}
