<script setup lang="ts">
const route = useRoute()
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--home': route.path === '/' }">
    <AppHeader />
    <main><slot /></main>
    <AppFooter />
  </div>
</template>
