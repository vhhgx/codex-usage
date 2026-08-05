export type CredentialImportTarget = 'cpa' | 'sub2api'

export interface CredentialSourceDocument {
  name: string
  value: unknown
}

export interface ConvertedCredentialAccount {
  key: string
  sourceName: string
  sourcePath: string
  sourceType: string
  name: string
  email: string | null
  accountId: string | null
  userId: string | null
  planType: string | null
  expiresAt: number | null
  accessTokenExpiresAt: number | null
  hasRefreshToken: boolean
  hasIdToken: boolean
  syntheticIdToken: boolean
  cpaReady: boolean
  warnings: string[]
  cpaCredential: Record<string, unknown>
  sub2apiCredentials: Record<string, unknown>
  sub2apiExtra: Record<string, unknown>
}

export interface SkippedCredentialSource {
  sourceName: string
  sourcePath: string
  message: string
}

export interface CredentialConversionResult {
  accounts: ConvertedCredentialAccount[]
  skipped: SkippedCredentialSource[]
}
