import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { updateSmsReceiver } from '../../../../services/sms-receivers'
import { assertUserPoolAccess } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  const id = getRouterParam(event, 'id') || ''
  const item = await updateSmsReceiver(event, id, await readBody<Record<string, unknown>>(event) || {}, user.userId, user.userId)
  await writeAudit(event, user.userId, 'pool.sms_receiver.update', 'sms_receiver', id)
  return { item }
})
