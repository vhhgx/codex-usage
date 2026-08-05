<script setup lang="ts">
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'

const route = useRoute()
const activeLayout = computed<'admin' | 'console' | 'default' | false>(() => {
  if (route.meta.layout === false) return false
  if (route.meta.layout === 'admin' || route.meta.layout === 'console' || route.meta.layout === 'default') return route.meta.layout
  if (route.path.startsWith('/admin')) return 'admin'
  if (route.path.startsWith('/console')) return 'console'
  return 'default'
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <AppToastViewport />
  <NuxtPage v-if="activeLayout === false" />
  <NuxtLayout v-else :name="activeLayout">
    <NuxtPage />
  </NuxtLayout>
</template>
