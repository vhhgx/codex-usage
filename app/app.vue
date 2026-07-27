<script setup lang="ts">
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'

const route = useRoute()
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--home': route.path === '/' }">
    <NuxtRouteAnnouncer />
    <AppHeader />
    <main>
      <NuxtPage />
    </main>
    <AppFooter />
  </div>
</template>
