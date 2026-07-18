export type QuotaWindowKind =
  | 'five-hour'
  | 'weekly'
  | 'monthly'
  | 'code-review-five-hour'
  | 'code-review-weekly'
  | 'code-review-monthly'
  | 'other'

export interface CodexQuotaWindow {
  id: string
  label: string
  kind: QuotaWindowKind
  usedPercent: number | null
  remainingPercent: number | null
  resetAt: number | null
  windowSeconds: number | null
}

export interface CodexAccountView {
  id: string
  name: string
  email: string | null
  note: string | null
  planType: string | null
  status: string
  disabled: boolean
  lastRefreshAt: number | null
}

export interface CodexQuotaResult extends CodexAccountView {
  quotaStatus: 'success' | 'error'
  windows: CodexQuotaWindow[]
  refreshedAt: number
  error?: string
}

export interface CodexAccountsResponse {
  accounts: CodexAccountView[]
  generatedAt: number
}

export interface CodexRefreshAllResponse {
  results: CodexQuotaResult[]
  successCount: number
  failureCount: number
  generatedAt: number
}
