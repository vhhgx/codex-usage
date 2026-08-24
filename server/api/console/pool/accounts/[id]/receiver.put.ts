import { requireUser, writeAudit } from '../../../../../services/admin-auth'
import { bindUserPoolAccountSmsReceiver } from '../../../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ receiverId?: unknown }>(event) || {}
  const receiverId = typeof body.receiverId === 'string' && body.receiverId ? body.receiverId : null
  const binding = await bindUserPoolAccountSmsReceiver(event, user.userId, id, receiverId, user.userId)
  await writeAudit(event, user.userId, 'pool.account.sms_receiver_bind', 'user_pool_account', id, { receiverId })
  return { binding }
})
