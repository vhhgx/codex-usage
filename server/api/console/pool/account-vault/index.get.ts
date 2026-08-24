import { requireUser } from '../../../../services/admin-auth'
import { listUserAccountVaultEntries } from '../../../../services/accounting'
import { getUserPool } from '../../../../services/user-pool'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { pool } = await getUserPool(event, user.userId)
  if (!pool) return { items: [] }
  return { items: await listUserAccountVaultEntries(event, user.userId, getQuery(event) as Record<string, string | undefined>) }
})
