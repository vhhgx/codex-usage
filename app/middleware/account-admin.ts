import type { AdminSessionView } from '#shared/types/hub'

export default defineNuxtRouteMiddleware(() => {
  const session = useState<AdminSessionView | null>('auth-session', () => null)
  if (!['super_admin', 'admin'].includes(session.value?.user?.role || '')) return navigateTo('/admin')
})
