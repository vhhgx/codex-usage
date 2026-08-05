import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { deleteLedgerTransaction } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const item = await deleteLedgerTransaction(event, id)
    await writeAudit(event, admin.userId, 'ledger.delete', 'ledger_transaction', id, { type: item.type, amountCents: item.amountCents })
    return { deleted: true }
  })
})
