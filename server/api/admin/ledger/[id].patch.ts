import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { updateLedgerTransaction } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await updateLedgerTransaction(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, 'ledger.update', 'ledger_transaction', id, { type: item.type, amountCents: item.amountCents })
    return { item }
  })
})
