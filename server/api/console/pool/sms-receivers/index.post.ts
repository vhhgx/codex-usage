import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { createSmsReceiver } from '../../../../services/sms-receivers'
import { assertUserPoolAccess } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  const item = await createSmsReceiver(event, await readBody<Record<string, unknown>>(event) || {}, user.userId, user.userId)
  await writeAudit(event, user.userId, 'pool.sms_receiver.create', 'sms_receiver', item.id, { phone: item.phone })
  return { item }
})
