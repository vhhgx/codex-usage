import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { importSmsReceivers } from '../../../../services/sms-receivers'
import { enforceRateLimit } from '../../../../utils/rate-limit'
import { assertUserPoolAccess } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  await enforceRateLimit(event, `pool-sms-import:${user.userId}`, 10, 60_000)
  const body = await readBody<Record<string, unknown>>(event) || {}
  const result = await importSmsReceivers(event, body.text, user.userId, user.userId)
  await writeAudit(event, user.userId, 'pool.sms_receiver.import', 'sms_receiver', null, { created: result.created.length, skipped: result.skipped.length, failed: result.failed.length })
  return result
})
