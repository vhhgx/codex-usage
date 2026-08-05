import { requireAccountAdmin } from '../../../services/admin-auth'
import { listAccountVaultEntries } from '../../../services/accounting'

export default defineEventHandler(async (event) => {
  await requireAccountAdmin(event)
  return { items: await listAccountVaultEntries(event, getQuery(event) as Record<string, string | undefined>) }
})
