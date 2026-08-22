import { requireUser } from '../../../../services/admin-auth'
import { completeUserPoolOAuth } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { account: await completeUserPoolOAuth(event, user.userId, await readBody<Record<string, unknown>>(event) || {}) }
})
