import { requireUser } from '../../../../services/admin-auth'
import { listSmsReceivers } from '../../../../services/sms-receivers'
import { assertUserPoolAccess } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  return { items: await listSmsReceivers(event, user.userId) }
})
