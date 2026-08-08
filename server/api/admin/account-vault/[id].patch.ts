import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { updateAccountVaultEntry } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await updateAccountVaultEntry(event, id, body, admin.userId)
    await writeAudit(event, admin.userId, 'account_vault.update', 'account_vault_entry', id, {
      fields: Object.keys(body).filter(field => !['password', 'totpSecret'].includes(field)),
      passwordChanged: typeof body.password === 'string' && Boolean(body.password),
      totpSecretChanged: Object.prototype.hasOwnProperty.call(body, 'totpSecret')
    })
    return { item }
  })
})
