<script setup lang="ts">
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'

const route = useRoute()
const { preference, resolvedTheme, systemDark, syncDocument } = useHubTheme()
let themeMedia: MediaQueryList | null = null

const activeLayout = computed<'admin' | 'console' | 'default' | false>(() => {
  if (route.meta.layout === false) return false
  if (route.meta.layout === 'admin' || route.meta.layout === 'console' || route.meta.layout === 'default') return route.meta.layout
  if (route.path.startsWith('/admin')) return 'admin'
  if (route.path.startsWith('/console')) return 'console'
  return 'default'
})

useHead(() => ({
  htmlAttrs: {
    class: preference.value === 'system' ? undefined : preference.value,
    'data-theme': preference.value
  },
  meta: preference.value === 'system'
    ? [
        { key: 'hub-theme-dark', name: 'theme-color', content: '#08090d', media: '(prefers-color-scheme: dark)', 'data-hub-theme': 'true' },
        { key: 'hub-theme-light', name: 'theme-color', content: '#f4f5f9', media: '(prefers-color-scheme: light)', 'data-hub-theme': 'true' }
      ]
    : [{ key: 'hub-theme', name: 'theme-color', content: resolvedTheme.value === 'dark' ? '#08090d' : '#f4f5f9', 'data-hub-theme': 'true' }]
}))

function handleSystemTheme(event: MediaQueryListEvent | MediaQueryList) {
  systemDark.value = event.matches
  syncDocument()
}

watch([preference, resolvedTheme], () => syncDocument(), { flush: 'post' })

onMounted(() => {
  themeMedia = window.matchMedia('(prefers-color-scheme: dark)')
  handleSystemTheme(themeMedia)
  themeMedia.addEventListener('change', handleSystemTheme)
})

onBeforeUnmount(() => themeMedia?.removeEventListener('change', handleSystemTheme))
</script>

<template>
  <NuxtRouteAnnouncer />
  <AppToastViewport />
  <NuxtPage v-if="activeLayout === false" />
  <NuxtLayout v-else :name="activeLayout">
    <NuxtPage />
  </NuxtLayout>
</template>
