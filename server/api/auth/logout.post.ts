import { logout, requireAuthenticated, writeAudit } from '../../services/admin-auth'

export default defineEventHandler(async (event) => {
  const session = await requireAuthenticated(event)
  await writeAudit(event, session.userId, 'session.logout', 'user', session.userId)
  await logout(event)
  return { success: true }
})
