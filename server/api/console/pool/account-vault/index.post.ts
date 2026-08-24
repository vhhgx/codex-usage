import { requireUser } from '../../../../services/admin-auth'
import { createAccountVaultEntry } from '../../../../services/accounting'
import { assertUserPoolAccess } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await assertUserPoolAccess(event, user.userId)
  const body = await readBody<Record<string, unknown>>(event) || {}
  return { item: await createAccountVaultEntry(event, body, user.userId, null, user.userId) }
})
