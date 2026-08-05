import { requireAdmin } from '../../../../../services/admin-auth'
import { listManagedCpaAuthFiles } from '../../../../../services/cpa'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { files: (await listManagedCpaAuthFiles(event)).map(item => item.view) }
})
