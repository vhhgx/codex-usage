import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { createLedgerTransaction } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await createLedgerTransaction(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'ledger.create', 'ledger_transaction', item.id, { type: item.type, amountCents: item.amountCents })
    return { item }
  })
})
