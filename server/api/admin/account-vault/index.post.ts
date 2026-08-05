import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { createAccountVaultEntry } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await createAccountVaultEntry(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'account_vault.create', 'account_vault_entry', item.id, { email: item.email, status: item.status })
    return { item }
  })
})
