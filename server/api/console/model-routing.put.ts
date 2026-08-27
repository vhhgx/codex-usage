import { requireUser, writeAudit } from '../../services/admin-auth'
import { updateUserModelRouting } from '../../services/user-model-routing'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const result = await updateUserModelRouting(event, user.userId, await readBody<Record<string, unknown>>(event) || {})
  await writeAudit(event, user.userId, 'model_routing.self_update', 'user', user.userId)
  return result
})
