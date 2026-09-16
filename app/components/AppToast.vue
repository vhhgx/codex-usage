<script setup lang="ts">
import { IconCheck, IconX, IconAlertTriangle, IconInfoCircle } from '@tabler/icons-vue'

export interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  duration: number
}

const iconStroke = 1.5
const toasts = ref<Toast[]>([])
let idCounter = 0

function show(message: string, type: Toast['type'] = 'info', duration = 5000) {
  const id = `toast-${++idCounter}`
  const toast: Toast = { id, message, type, duration }
  toasts.value.push(toast)

  if (duration > 0) {
    setTimeout(() => dismiss(id), duration)
  }

  return id
}

function dismiss(id: string) {
  const index = toasts.value.findIndex(t => t.id === id)
  if (index >= 0) {
    toasts.value.splice(index, 1)
  }
}

defineExpose({ show, dismiss })
</script>

<template>
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :data-type="toast.type"
        role="alert"
        :aria-live="toast.type === 'error' ? 'assertive' : 'polite'"
      >
        <div class="toast__icon">
          <IconCheck v-if="toast.type === 'success'" :size="18" :stroke-width="iconStroke" />
          <IconX v-else-if="toast.type === 'error'" :size="18" :stroke-width="iconStroke" />
          <IconAlertTriangle v-else-if="toast.type === 'warning'" :size="18" :stroke-width="iconStroke" />
          <IconInfoCircle v-else :size="18" :stroke-width="iconStroke" />
        </div>
        <p class="toast__message">{{ toast.message }}</p>
        <button
          type="button"
          class="toast__close"
          :aria-label="`关闭通知：${toast.message}`"
          @click="dismiss(toast.id)"
        >
          <IconX :size="16" :stroke-width="iconStroke" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  pointer-events: none;
}

.toast {
  min-width: 320px;
  max-width: 480px;
  padding: 0.875rem 1rem;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  border-radius: var(--hub-radius-panel);
  background: var(--hub-solid-surface);
  box-shadow:
    0 0 0 1px var(--hub-line-strong),
    0 8px 16px rgba(0, 0, 0, 0.12),
    0 2px 4px rgba(0, 0, 0, 0.08);
  pointer-events: auto;
  animation: toast-slide-in 0.3s var(--hub-motion-ease);
}

.toast[data-type='success'] {
  border-left: 3px solid var(--hub-success);
}

.toast[data-type='error'] {
  border-left: 3px solid var(--hub-danger);
}

.toast[data-type='warning'] {
  border-left: 3px solid var(--hub-warning);
}

.toast[data-type='info'] {
  border-left: 3px solid var(--hub-accent);
}

.toast__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.toast[data-type='success'] .toast__icon {
  color: var(--hub-success);
  background: var(--hub-success-soft);
}

.toast[data-type='error'] .toast__icon {
  color: var(--hub-danger);
  background: var(--hub-danger-soft);
}

.toast[data-type='warning'] .toast__icon {
  color: var(--hub-warning);
  background: var(--hub-warning-soft);
}

.toast[data-type='info'] .toast__icon {
  color: var(--hub-accent);
  background: var(--hub-accent-soft);
}

.toast__message {
  flex: 1;
  margin: 0;
  padding-top: 2px;
  font-size: 0.875rem;
  line-height: 1.4;
  color: var(--hub-text);
}

.toast__close {
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--hub-text-soft);
  background: transparent;
  cursor: pointer;
  transition: var(--hub-state-transition);
}

.toast__close:hover {
  color: var(--hub-text);
  background: var(--hub-surface-2);
}

.toast__close:active {
  transform: scale(0.95);
}

@keyframes toast-slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s var(--hub-motion-ease);
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(50%) scale(0.9);
}

.toast-move {
  transition: transform 0.3s var(--hub-motion-ease);
}

@media (max-width: 640px) {
  .toast-container {
    top: auto;
    bottom: 1rem;
    right: 1rem;
    left: 1rem;
  }

  .toast {
    min-width: 0;
    max-width: none;
  }
}
</style>
