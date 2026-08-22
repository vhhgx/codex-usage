import { requireUser } from '../../../../services/admin-auth'
import { updateUserPoolAccount } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') || ''
  return { account: await updateUserPoolAccount(event, user.userId, id, await readBody<Record<string, unknown>>(event) || {}) }
})
