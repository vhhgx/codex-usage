import { requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { importSmsReceivers } from '../../../services/sms-receivers'
import { enforceRateLimit } from '../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  await enforceRateLimit(event, `admin-sms-import:${admin.userId}`, 10, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const result = await importSmsReceivers(event, body.text, admin.userId)
  await writeAudit(event, admin.userId, 'sms_receiver.import', 'sms_receiver', null, {
    created: result.created.length,
    skipped: result.skipped.length,
    failed: result.failed.length
  })
  return result
})
