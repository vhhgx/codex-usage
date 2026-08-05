import { requireAdmin } from '../../../../../services/admin-auth'
import { listManagedSub2ApiGroups } from '../../../../../services/sub2api-admin'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { groups: (await listManagedSub2ApiGroups(event)).map(item => item.view) }
})
