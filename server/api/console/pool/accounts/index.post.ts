import { requireUser } from '../../../../services/admin-auth'
import { importUserPoolAccount } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { account: await importUserPoolAccount(event, user.userId, await readBody<Record<string, unknown>>(event) || {}) }
})
