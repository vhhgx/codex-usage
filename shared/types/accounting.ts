export const ACCOUNT_VAULT_STATUSES = ['Codex', '已登录', '仅Web', '已过期', '已封禁', '接码失效'] as const
export const WARRANTY_STATUSES = ['有质保', '无质保'] as const
export const LEDGER_TRANSACTION_TYPES = [
  'personal_expense',
  'personal_income',
  'linglong_expense',
  'nvtokens_topup',
  'nvtokens_consumption'
] as const

export type AccountVaultStatus = typeof ACCOUNT_VAULT_STATUSES[number]
export type WarrantyStatus = typeof WARRANTY_STATUSES[number]
export type LedgerTransactionType = typeof LEDGER_TRANSACTION_TYPES[number]
export type AccountCredentialKind = 'password' | 'email_code_url' | 'tokens'
export type AccountSub2ApiPoolStatus = 'not_added' | 'active' | 'deleted'
export type AccountDeliveryFormat = 'email_code_url' | 'tokens' | 'password_totp'

export interface AccountSmsReceiverView {
  id: string
  phone: string
  copyValue: string
  providerHost: string
  bindingCount: number
  slot: number
  codeReceivedAt: number | null
  lastFetchedAt: number | null
  lastFetchStatus: string | null
}

export interface AccountVaultView {
  id: string
  email: string
  displayName: string | null
  status: AccountVaultStatus
  credentialKind: AccountCredentialKind
  hasEmailCodeUrl: boolean
  hasTotpSecret: boolean
  smsVerifiedAt: number | null
  sub2apiAccountId: string | null
  sub2apiPoolStatus: AccountSub2ApiPoolStatus
  codexAddedAt: number | null
  sub2apiRemovedAt: number | null
  maskedPassword: string
  purchaseDate: string | null
  warrantyDate: string | null
  warrantyStatus: WarrantyStatus
  smsReceiver: AccountSmsReceiverView | null
  remark: string | null
  createdAt: number
  updatedAt: number
}

export interface SmsReceiverView {
  id: string
  phone: string
  copyValue: string
  providerHost: string
  note: string | null
  status: 'active' | 'disabled'
  bindingCount: number
  availableSlots: number
  accounts: Array<{ bindingId: string; id: string; email: string; displayName: string | null; slot: number; deleted: boolean }>
  lastFetchedAt: number | null
  lastFetchStatus: string | null
  lastFetchError: string | null
  createdAt: number
  updatedAt: number
}

export interface SmsCodeResult {
  receiverId: string
  phone: string
  code: string | null
  message: string
  fetchedAt: number
}

export interface SmsReceiverImportResult {
  created: Array<{ line: number; id: string; phone: string; providerHost: string }>
  skipped: Array<{ line: number; phone: string; reason: string }>
  failed: Array<{ line: number; phone: string | null; error: string }>
}

export interface AccountTotpCodeResult {
  accountId: string
  code: string
  generatedAt: number
  expiresAt: number
}

export interface LedgerTransactionView {
  id: string
  occurredOn: string
  type: LedgerTransactionType
  project: string
  unitPriceCents: number
  quantity: number
  amountCents: number
  note: string
  createdAt: number
  updatedAt: number
}

export interface LedgerSummary {
  recordCount: number
  totalExpenseCents: number
  personalExpenseCents: number
  personalIncomeCents: number
  linglongExpenseCents: number
  nvtokensTopupCents: number
  nvtokensConsumptionCents: number
  nvtokensBalanceCents: number
  netCents: number
}
