import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { importAccountDeliveryText } from '../../../services/accounting'
import { enforceRateLimit } from '../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  await enforceRateLimit(event, `admin-account-delivery-import:${admin.userId}`, 10, 60_000)
  const body = await readBody<{ text?: unknown; fields?: unknown; source?: unknown }>(event) || {}
  return auditedMutation(event, async () => {
    const result = await importAccountDeliveryText(event, body.text, body.fields, body.source, admin.userId)
    await writeAudit(event, admin.userId, 'account_vault.delivery_import', 'account_vault_entry', null, {
      created: result.created,
      skipped: result.skipped,
      failed: result.failed.length,
      fields: Array.isArray(body.fields) ? body.fields : [],
      source: body.source
    })
    return result
  })
})
