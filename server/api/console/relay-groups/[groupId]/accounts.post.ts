import { requireUser } from '../../../../services/admin-auth'
import { createUserRelay } from '../../../../services/user-relays'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return createUserRelay(event, user.userId, { ...body, groupId: getRouterParam(event, 'groupId') || '' })
})
