import { requireAccountAdmin } from '../../../services/admin-auth'
import { listLedgerTransactions } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  await requireAccountAdmin(event)
  return listLedgerTransactions(event, getQuery(event) as Record<string, string | undefined>)
})
