import { requireAccountAdmin } from '../../../services/admin-auth'
import { listSmsReceivers } from '../../../services/sms-receivers'

export default defineEventHandler(async (event) => {
  await requireAccountAdmin(event)
  return { items: await listSmsReceivers(event) }
})
