<script setup lang="ts">
import { IconAlertCircle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-vue'

const { items, dismiss } = useAppToast()
const icon = (tone: 'success' | 'error' | 'info') => tone === 'success'
  ? IconCircleCheck
  : tone === 'error'
    ? IconAlertCircle
    : IconInfoCircle
</script>

<template>
  <ClientOnly>
    <Teleport to="body">
      <section class="app-toast-viewport" aria-live="polite" aria-label="操作通知">
        <article v-for="item in items" :key="item.id" class="app-toast" :data-tone="item.tone" :role="item.tone === 'error' ? 'alert' : 'status'">
          <component :is="icon(item.tone)" :size="19" :stroke-width="1.9" />
          <p>{{ item.message }}</p>
          <button type="button" title="关闭通知" aria-label="关闭通知" @click="dismiss(item.id)">
            <IconX :size="17" />
          </button>
        </article>
      </section>
    </Teleport>
  </ClientOnly>
</template>
