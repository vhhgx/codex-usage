import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { deleteAccountVaultEntry } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const deleted = await deleteAccountVaultEntry(event, id)
    await writeAudit(event, admin.userId, 'account_vault.delete', 'account_vault_entry', id, { email: deleted.email })
    return { deleted: true }
  })
})
