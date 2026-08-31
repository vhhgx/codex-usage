export interface UserPoolActivationResult {
  accountId: string
  enabled: boolean
  error?: unknown
}

interface UserPoolRequestOptions {
  method: 'POST' | 'PATCH'
  body?: { schedulable: true }
}

export type UserPoolRequest = (url: string, options: UserPoolRequestOptions) => Promise<unknown>

export async function verifyAndEnableUserPoolAccounts(accountIds: string[], request: UserPoolRequest): Promise<UserPoolActivationResult[]> {
  const results = new Array<UserPoolActivationResult>(accountIds.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < accountIds.length) {
      const index = nextIndex++
      const accountId = accountIds[index]!
      const encodedId = encodeURIComponent(accountId)
      try {
        await request(`/api/console/pool/accounts/${encodedId}/verify`, { method: 'POST' })
        await request(`/api/console/pool/accounts/${encodedId}`, { method: 'PATCH', body: { schedulable: true } })
        results[index] = { accountId, enabled: true }
      } catch (error) {
        results[index] = { accountId, enabled: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, accountIds.length) }, worker))
  return results
}
