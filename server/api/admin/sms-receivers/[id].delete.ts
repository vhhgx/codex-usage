import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { deleteSmsReceiver } from '../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  return auditedMutation(event, async () => {
    const deleted = await deleteSmsReceiver(event, id)
    await writeAudit(event, admin.userId, 'sms_receiver.delete', 'sms_receiver', id, { phone: deleted.phone })
    return { deleted: true }
  })
})
