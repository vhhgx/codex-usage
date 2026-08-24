import { requireUser, writeAudit } from '../../../../services/admin-auth'
import { deleteSmsReceiver } from '../../../../services/sms-receivers'
import { assertUserPoolAccess } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  const id = getRouterParam(event, 'id') || ''
  const deleted = await deleteSmsReceiver(event, id, user.userId)
  await writeAudit(event, user.userId, 'pool.sms_receiver.delete', 'sms_receiver', id)
  return { deleted }
})
