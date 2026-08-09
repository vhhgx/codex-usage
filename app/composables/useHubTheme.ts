export type HubThemePreference = 'system' | 'dark' | 'light'

const THEME_COLORS = {
  dark: '#08090d',
  light: '#f4f5f9'
} as const

export function useHubTheme() {
  const preference = useCookie<HubThemePreference>('zephyr_theme', {
    default: () => 'system',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax'
  })
  const systemDark = useState('hub-system-dark', () => false)
  const resolvedTheme = computed<'dark' | 'light'>(() =>
    preference.value === 'system'
      ? (systemDark.value ? 'dark' : 'light')
      : preference.value
  )

  function setTheme(value: HubThemePreference) {
    preference.value = value
  }

  function toggleTheme() {
    setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark')
  }

  function syncDocument() {
    if (!import.meta.client) return
    const root = document.documentElement
    root.classList.toggle('dark', preference.value === 'dark')
    root.classList.toggle('light', preference.value === 'light')
    root.dataset.theme = preference.value
    root.style.colorScheme = resolvedTheme.value
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-hub-theme]').forEach((element) => {
      element.content = THEME_COLORS[resolvedTheme.value]
    })
  }

  return { preference, resolvedTheme, setTheme, toggleTheme, syncDocument, systemDark }
}
