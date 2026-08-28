<script setup lang="ts">
import type { Component } from 'vue'

interface ChoiceOption {
  value: string
  label: string
  hint?: string
  icon?: Component
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  options: ChoiceOption[]
  name: string
  label?: string
  legend?: string
  columns?: 1 | 2
  compact?: boolean
}>(), {
  label: '',
  legend: '',
  columns: 1,
  compact: false
})

const model = defineModel<string>({ default: '' })
</script>

<template>
  <fieldset
    class="app-choice-group app-choice-group--radio"
    :class="{ 'app-choice-group--compact': compact, 'app-choice-group--two-columns': columns === 2 }"
    :aria-label="legend ? undefined : (label || undefined)"
  >
    <legend v-if="legend" class="app-choice-group__legend">{{ legend }}</legend>
    <div class="app-choice-options">
      <label v-for="option in props.options" :key="option.value" class="app-choice-option" :class="{ 'is-disabled': option.disabled }">
        <input v-model="model" type="radio" :name="name" :value="option.value" :disabled="option.disabled">
        <span class="app-choice-surface">
          <span v-if="option.icon" class="app-choice-icon"><component :is="option.icon" :size="14" :stroke-width="1.7" /></span>
          <span class="app-choice-copy"><strong>{{ option.label }}</strong><small v-if="option.hint">{{ option.hint }}</small></span>
          <span class="app-choice-mark app-choice-mark--radio" aria-hidden="true" />
        </span>
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.app-choice-group { min-width: 0; margin: 0; padding: 0; border: 0; display: grid; gap: .55rem; }
.app-choice-group__legend { margin: 0; color: var(--hub-text-muted); font-size: .74rem; font-weight: var(--hub-weight-medium); }
.app-choice-options { min-width: 0; display: grid; grid-template-columns: 1fr; gap: .85rem; }
.app-choice-group--two-columns .app-choice-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.app-choice-group--compact .app-choice-options { gap: .42rem; }
.app-choice-option { position: relative; min-width: 0; display: block; cursor: pointer; }
.app-choice-option.is-disabled { cursor: not-allowed; opacity: .58; }
.app-choice-option > input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.app-choice-surface { min-width: 0; min-height: 3.35rem; padding: .55rem .6rem; border: 1px solid var(--hub-line); border-radius: 6px; display: flex; align-items: center; gap: .58rem; color: var(--hub-text-muted); background: color-mix(in srgb, var(--hub-glass) 50%, transparent); box-shadow: var(--hub-panel-highlight); transition: border-color var(--hub-duration-base) ease, background-color var(--hub-duration-base) ease, box-shadow var(--hub-duration-base) ease, transform var(--hub-duration-fast) ease; }
.app-choice-group--compact .app-choice-surface { min-height: 2.85rem; padding-block: .42rem; }
.app-choice-option:hover:not(.is-disabled) .app-choice-surface { border-color: var(--hub-line-strong); background: var(--hub-glass-hover); }
.app-choice-option:active:not(.is-disabled) .app-choice-surface { transform: translateY(1px) scale(.99); }
.app-choice-option > input:focus-visible + .app-choice-surface { outline: 2px solid var(--hub-focus-ring); outline-offset: 2px; }
.app-choice-option > input:checked + .app-choice-surface { border-color: var(--hub-accent-line); color: var(--hub-text); background: linear-gradient(100deg, var(--hub-accent-soft), color-mix(in srgb, var(--hub-accent-soft) 45%, transparent)); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); }
.app-choice-icon { width: 1.8rem; height: 1.8rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-line); border-radius: 5px; color: var(--hub-text-faint); background: var(--hub-glass-strong); transition: color var(--hub-duration-base) ease, border-color var(--hub-duration-base) ease, background-color var(--hub-duration-base) ease; }
.app-choice-option > input:checked + .app-choice-surface .app-choice-icon { border-color: var(--hub-accent-line); color: var(--hub-accent-bright); background: var(--hub-accent-soft); }
.app-choice-copy { min-width: 0; flex: 1; }
.app-choice-copy strong, .app-choice-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-choice-copy strong { color: var(--hub-text); font-size: .7rem; font-weight: var(--hub-weight-medium); }
.app-choice-copy small { margin-top: .18rem; color: var(--hub-text-faint); font-size: .57rem; font-weight: var(--hub-weight-regular); }
.app-choice-group--compact .app-choice-copy strong { font-size: .68rem; }
.app-choice-group--compact .app-choice-copy small { font-size: .56rem; }
.app-choice-mark { width: .75rem; height: .75rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-text-disabled); color: transparent; font-size: .52rem; }
.app-choice-mark--radio { border-radius: 50%; }
.app-choice-option > input:checked + .app-choice-surface .app-choice-mark--radio { border-color: var(--hub-accent); background: var(--hub-accent); box-shadow: 0 0 8px var(--hub-accent-soft); }
@media (max-width: 820px) {
  .app-choice-group--two-columns .app-choice-options { grid-template-columns: 1fr; }
}
</style>
