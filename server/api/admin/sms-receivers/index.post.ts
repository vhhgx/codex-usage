import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../services/admin-auth'
import { createSmsReceiver } from '../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const item = await createSmsReceiver(event, body, admin.userId)
    await writeAudit(event, admin.userId, 'sms_receiver.create', 'sms_receiver', item.id, {
      phone: item.phone,
      providerHost: item.providerHost,
      status: item.status
    })
    return { item }
  })
})
