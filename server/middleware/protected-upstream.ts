import { requireAdmin } from '../services/admin-auth'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  const protectedPath = path === '/api/codex-radar' ||
    path.startsWith('/api/codex/') ||
    path.startsWith('/api/sub2api/') ||
    path === '/api/usage/query'
  if (protectedPath) await requireAdmin(event)
})
