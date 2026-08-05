import type { AdminSessionView } from '#shared/types/hub'

export default defineNuxtRouteMiddleware(async (to) => {
  const session = useState<AdminSessionView | null>('auth-session', () => null)
  try {
    session.value = await useRequestFetch()<AdminSessionView>('/api/auth/session')
  } catch {
    session.value = { authenticated: false, user: null }
  }
  if (!session.value.authenticated) return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  if (session.value.user?.role === 'user') return navigateTo('/console')
})
