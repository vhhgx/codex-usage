import { getSession } from '../../services/admin-auth'

export default defineEventHandler(async (event) => {
  const session = await getSession(event)
  return {
    authenticated: Boolean(session),
    user: session ? { id: session.userId, username: session.username, role: session.role, mustChangePassword: session.mustChangePassword } : null
  }
})
