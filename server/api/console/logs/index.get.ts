import { requireUser } from '../../../services/admin-auth'
import { listUserLogs } from '../../../services/user-console'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  return listUserLogs(event, user.userId, Number(query.page) || 1, Number(query.pageSize) || 50)
})
