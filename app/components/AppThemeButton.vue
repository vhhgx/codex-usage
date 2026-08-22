<script setup lang="ts">
import { IconMoon, IconSun } from '@tabler/icons-vue'

const { resolvedTheme, toggleTheme } = useHubTheme()
</script>

<template>
  <button
    class="icon-button theme-button"
    type="button"
    :title="resolvedTheme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'"
    :aria-label="resolvedTheme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'"
    @click="toggleTheme"
  >
    <IconSun v-if="resolvedTheme === 'dark'" :size="17" :stroke-width="1.8" />
    <IconMoon v-else :size="17" :stroke-width="1.8" />
  </button>
</template>
