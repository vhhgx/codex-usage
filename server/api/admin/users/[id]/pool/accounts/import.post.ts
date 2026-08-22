import { requireAccountAdmin } from '../../../../../../services/admin-auth'
import { importUserPoolAccount } from '../../../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const admin = await requireAccountAdmin(event)
  return { account: await importUserPoolAccount(event, getRouterParam(event, 'id') || '', await readBody<Record<string, unknown>>(event) || {}, admin.userId) }
})
