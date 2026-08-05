import { getSession } from '../services/admin-auth'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  const protectedPath = path.startsWith('/api/admin/') || path.startsWith('/api/console/') || path.startsWith('/api/auth/')
  if (!protectedPath || path === '/api/auth/login') return
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.method)) return
  if (path.startsWith('/api/admin/')) {
    const session = await getSession(event)
    if (session?.role === 'auditor') throw createError({ statusCode: 403, message: '审计员只有只读权限' })
  }
  const origin = getHeader(event, 'origin')
  const host = getHeader(event, 'host')
  if (!origin || !host) return
  try {
    if (new URL(origin).host !== host) throw new Error('origin mismatch')
  } catch {
    throw createError({ statusCode: 403, message: '请求来源验证失败' })
  }
})
