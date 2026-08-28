<script setup lang="ts">
import type { ButtonHTMLAttributes } from 'vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  size?: 'default' | 'small'
  type?: ButtonHTMLAttributes['type']
  loading?: boolean
  loadingLabel?: string
}>(), {
  variant: 'secondary',
  size: 'default',
  type: 'button',
  loading: false,
  loadingLabel: '处理中'
})

const attrs = useAttrs()
const disabled = computed(() => props.loading || attrs.disabled === true || attrs.disabled === '')
</script>

<template>
  <button
    v-bind="attrs"
    class="button app-button"
    :class="[`button--${variant}`, { 'button--small': size === 'small', 'is-loading': loading }]"
    :type="type"
    :disabled="disabled"
    :aria-busy="loading || undefined"
  >
    <template v-if="loading">{{ loadingLabel }}</template>
    <slot v-else />
  </button>
</template>

<style scoped>
.app-button { min-height: var(--hub-control-height); padding-inline: var(--hub-space-4); display: inline-flex; align-items: center; justify-content: center; gap: .45rem; border: 1px solid transparent; border-radius: var(--hub-radius-lg); font-size: var(--hub-text-sm); font-weight: var(--hub-weight-semibold); line-height: 1; white-space: nowrap; cursor: pointer; transition: transform var(--hub-duration-fast) ease, color var(--hub-duration-base) ease, background-color var(--hub-duration-base) ease, border-color var(--hub-duration-base) ease, opacity var(--hub-duration-base) ease; }
.app-button.button--small { min-height: var(--hub-control-height-compact); padding-inline: var(--hub-space-3); font-size: var(--hub-text-xs); }
.app-button.button--primary { color: var(--hub-accent-text); border-color: var(--hub-accent-line); background: linear-gradient(180deg, color-mix(in srgb, var(--hub-accent) 24%, transparent), color-mix(in srgb, var(--hub-accent) 14%, transparent)); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); }
.app-button.button--primary:hover:not(:disabled) { color: var(--hub-accent-text); border-color: var(--hub-accent); background: var(--hub-accent-soft); }
.app-button.button--secondary { color: var(--hub-button-secondary-fg); border-color: var(--hub-line-strong); background: var(--hub-button-secondary-bg); }
.app-button.button--secondary:hover:not(:disabled) { border-color: var(--hub-accent-line); background: var(--hub-accent-soft); }
.app-button.button--quiet { color: var(--hub-button-quiet-fg); border-color: var(--hub-line); background: var(--hub-button-quiet-bg); }
.app-button.button--quiet:hover:not(:disabled) { border-color: var(--hub-accent-line); background: var(--hub-accent-soft); }
.app-button.button--danger { color: var(--hub-button-danger-fg); border-color: var(--hub-button-danger-bg); background: var(--hub-button-danger-bg); }
.app-button.button--danger:hover:not(:disabled) { border-color: var(--hub-danger); background: var(--hub-danger); }
.app-button:active:not(:disabled) { transform: translateY(1px); }
.app-button:disabled { cursor: not-allowed; opacity: .5; }
</style>
