import { requireAdmin } from '../../../../../services/admin-auth'
import { listManagedSub2ApiAccounts } from '../../../../../services/sub2api-admin'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { accounts: (await listManagedSub2ApiAccounts(event)).map(item => item.view) }
})
