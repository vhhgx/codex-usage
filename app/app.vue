<script setup lang="ts">
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'
</script>

<template>
  <div class="app-shell">
    <NuxtRouteAnnouncer />
    <AppHeader />
    <main>
      <NuxtPage />
    </main>
    <AppFooter />
  </div>
</template>
