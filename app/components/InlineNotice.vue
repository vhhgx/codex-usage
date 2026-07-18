<script setup lang="ts">
import { IconAlertCircle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-vue'

const props = withDefaults(
  defineProps<{
    tone?: 'info' | 'success' | 'error'
    title: string
    message?: string
  }>(),
  { tone: 'info', message: '' }
)

const icon = computed(() => {
  if (props.tone === 'success') return IconCircleCheck
  if (props.tone === 'error') return IconAlertCircle
  return IconInfoCircle
})
</script>

<template>
  <div class="notice" :class="`notice--${tone}`" role="status">
    <component :is="icon" :size="20" :stroke-width="1.8" />
    <div>
      <strong>{{ title }}</strong>
      <p v-if="message">{{ message }}</p>
    </div>
  </div>
</template>
