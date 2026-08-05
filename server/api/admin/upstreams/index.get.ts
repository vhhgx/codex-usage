import { requireAdmin } from '../../../services/admin-auth'
import { listUpstreamConnections } from '../../../services/upstream-connections'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return { upstreams: listUpstreamConnections(event) }
})
