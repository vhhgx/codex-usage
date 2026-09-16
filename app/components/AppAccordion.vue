<script setup lang="ts">
import { IconChevronDown } from '@tabler/icons-vue'

interface Props {
  title: string
  subtitle?: string
  defaultOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  defaultOpen: false
})

const iconStroke = 1.5
const isOpen = ref(props.defaultOpen)

function toggle() {
  isOpen.value = !isOpen.value
}
</script>

<template>
  <div class="accordion" :data-open="isOpen">
    <button type="button" class="accordion__trigger" :aria-expanded="isOpen" @click="toggle">
      <div class="accordion__header">
        <strong>{{ title }}</strong>
        <small v-if="subtitle">{{ subtitle }}</small>
      </div>
      <IconChevronDown :size="16" :stroke-width="iconStroke" class="accordion__icon" />
    </button>
    <div v-if="isOpen" class="accordion__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.accordion {
  border: 1px solid var(--hub-line);
  border-radius: var(--hub-radius-panel);
  background: var(--hub-solid-surface);
  transition: var(--hub-state-transition);
}

.accordion[data-open='true'] {
  border-color: var(--hub-line-strong);
}

.accordion__trigger {
  width: 100%;
  min-height: 52px;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 0;
  background: transparent;
  color: var(--hub-text);
  cursor: pointer;
  transition: var(--hub-state-transition);
}

.accordion__trigger:hover {
  background: var(--hub-surface-2);
}

.accordion__header {
  display: grid;
  gap: 0.25rem;
  text-align: left;
}

.accordion__header strong {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--hub-text);
}

.accordion__header small {
  font-size: 0.75rem;
  color: var(--hub-text-faint);
}

.accordion__icon {
  flex: none;
  color: var(--hub-text-soft);
  transition: transform 0.3s var(--hub-motion-ease);
}

.accordion[data-open='true'] .accordion__icon {
  transform: rotate(180deg);
}

.accordion__content {
  padding: 0 1rem 1rem;
  animation: accordion-slide-down 0.3s var(--hub-motion-ease);
}

@keyframes accordion-slide-down {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
