import { requireAccountAdmin } from '../../../../../../services/admin-auth'
import { completeUserPoolOAuth } from '../../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  await requireAccountAdmin(event)
  return { account: await completeUserPoolOAuth(event, getRouterParam(event, 'id') || '', await readBody<Record<string, unknown>>(event) || {}) }
})
