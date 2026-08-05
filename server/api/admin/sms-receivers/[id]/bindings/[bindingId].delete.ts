import { auditedMutation, requireAccountAdmin, writeAudit } from '../../../../../services/admin-auth'
import { deleteSmsReceiverBinding } from '../../../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  const receiverId = getRouterParam(event, 'id') || ''
  const bindingId = getRouterParam(event, 'bindingId') || ''
  return auditedMutation(event, async () => {
    const binding = await deleteSmsReceiverBinding(event, receiverId, bindingId)
    await writeAudit(event, admin.userId, 'sms_receiver.binding_delete', 'sms_receiver_binding', bindingId, {
      receiverId,
      accountId: binding.accountId,
      email: binding.email,
      deletedAccount: binding.deletedAccount
    })
    return { deleted: true, binding }
  })
})
