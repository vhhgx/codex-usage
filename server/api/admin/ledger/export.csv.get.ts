import { requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { exportLedgerCsv } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const query = getQuery(event) as Record<string, string | undefined>
  const csv = await exportLedgerCsv(event, query)
  await writeAudit(event, admin.userId, 'ledger.export', 'ledger_transaction', null, { filtered: Object.keys(query).length > 0 })
  setResponseHeaders(event, {
    'cache-control': 'no-store, private',
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="ledger-${new Date().toISOString().slice(0, 10)}.csv"`
  })
  return csv
})
