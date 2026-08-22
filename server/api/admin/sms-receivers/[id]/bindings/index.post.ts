import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../../services/admin-auth'
import { addManualSmsReceiverBinding, listSmsReceivers } from '../../../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const receiverId = getRouterParam(event, 'id') || ''
  const body = await readBody<Record<string, unknown>>(event) || {}
  return auditedMutation(event, async () => {
    const binding = await addManualSmsReceiverBinding(event, receiverId, body, admin.userId)
    await writeAudit(event, admin.userId, 'sms_receiver.binding_add', 'sms_receiver_binding', binding.id, {
      receiverId,
      email: binding.accountEmail,
      displayName: binding.accountDisplayName,
      manual: true
    })
    const item = (await listSmsReceivers(event)).find(receiver => receiver.id === receiverId)
    return { item, binding }
  })
})
