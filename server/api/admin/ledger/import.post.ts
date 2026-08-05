import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { importLedgerTransactions } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<{ records?: unknown; source?: unknown }>(event) || {}
  return auditedMutation(event, async () => {
    const result = await importLedgerTransactions(event, body.records, admin.userId, typeof body.source === 'string' ? body.source : 'json')
    await writeAudit(event, admin.userId, 'ledger.import', 'ledger_transaction', null, {
      created: result.created,
      skipped: result.skipped,
      failed: result.failed.length
    })
    return result
  })
})
