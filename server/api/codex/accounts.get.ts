import type { CodexAccountsResponse } from '#shared/types/codex'
import { listCodexAccounts } from '../../services/cpa'

export default defineEventHandler(async (event): Promise<CodexAccountsResponse> => {
  const accounts = await listCodexAccounts(event)
  return {
    accounts: accounts.filter((account) => !account.view.disabled).map((account) => account.view),
    generatedAt: Date.now()
  }
})
