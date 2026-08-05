import { requireAdmin } from '../../../../../services/admin-auth'
import { getManagedCpaProxyState } from '../../../../../services/cpa'
import { getManagedSub2ApiProxyState } from '../../../../../services/sub2api-admin'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const [subState, cpaState] = await Promise.all([
    getManagedSub2ApiProxyState(event),
    getManagedCpaProxyState(event)
  ])
  return { ...subState, ...cpaState }
})
