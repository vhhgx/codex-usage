<script setup lang="ts">
import { IconInbox } from '@tabler/icons-vue'

interface Props {
  icon?: any
  title?: string
  message?: string
  actionLabel?: string
  actionTo?: string
}

const props = withDefaults(defineProps<Props>(), {
  icon: IconInbox,
  title: '',
  message: '',
  actionLabel: '',
  actionTo: ''
})

const iconStroke = 1.5
</script>

<template>
  <div class="empty-state">
    <component :is="icon" :size="32" :stroke-width="iconStroke" class="empty-state__icon" />
    <div v-if="title || message" class="empty-state__content">
      <strong v-if="title">{{ title }}</strong>
      <p v-if="message">{{ message }}</p>
    </div>
    <slot />
    <NuxtLink
      v-if="actionTo && actionLabel"
      :to="actionTo"
      class="button button--primary button--small"
    >
      {{ actionLabel }}
    </NuxtLink>
  </div>
</template>

<style scoped>
.empty-state {
  min-height: 180px;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  text-align: center;
}

.empty-state__icon {
  color: var(--hub-text-faint);
  opacity: 0.5;
}

.empty-state__content {
  display: grid;
  gap: 6px;
}

.empty-state__content strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--hub-text-muted);
}

.empty-state__content p {
  margin: 0;
  font-size: 12px;
  color: var(--hub-text-faint);
  line-height: 1.5;
}
</style>
