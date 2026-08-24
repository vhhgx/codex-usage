import { requireUser } from '../../../../services/admin-auth'
import { importAccountDeliveryText } from '../../../../services/accounting'
import { assertUserPoolAccess } from '../../../../services/user-pool'
import { enforceRateLimit } from '../../../../utils/rate-limit'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  await enforceRateLimit(event, `console-pool-delivery-import:${user.userId}`, 10, 60_000)
  const body = await readBody<{ text?: unknown; fields?: unknown; source?: unknown }>(event) || {}
  return importAccountDeliveryText(event, body.text, body.fields, body.source, user.userId, user.userId)
})
