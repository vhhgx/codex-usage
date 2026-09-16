<script setup lang="ts">
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-vue'

const props = withDefaults(
  defineProps<{
    tone?: 'info' | 'success' | 'error' | 'warning'
    title: string
    message?: string
  }>(),
  { tone: 'info', message: '' }
)

const icon = computed(() => {
  if (props.tone === 'success') return IconCircleCheck
  if (props.tone === 'error') return IconAlertCircle
  if (props.tone === 'warning') return IconAlertTriangle
  return IconInfoCircle
})
</script>

<template>
  <div class="notice" :class="`notice--${tone}`" role="status">
    <component :is="icon" :size="20" :stroke-width="1.5" />
    <div>
      <strong>{{ title }}</strong>
      <p v-if="message">{{ message }}</p>
    </div>
  </div>
</template>
