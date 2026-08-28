<script setup lang="ts">
import { IconCheck, IconChevronDown } from '@tabler/icons-vue'
import { useId } from 'vue'

interface FilterSelectOption {
  value: string
  label: string
  disabled?: boolean
}

const props = defineProps<{
  options: FilterSelectOption[]
  label: string
  disabled?: boolean
}>()

const model = defineModel<string>({ default: '' })
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const listboxId = `filter-select-${useId().replaceAll(':', '')}`

const selectedIndex = computed(() => props.options.findIndex(option => option.value === model.value))
const selectedLabel = computed(() => props.options[selectedIndex.value]?.label || props.options[0]?.label || '')

function enabledIndexes() {
  return props.options.flatMap((option, index) => option.disabled ? [] : [index])
}

function optionButtons() {
  return Array.from(root.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])
}

async function focusOption(index: number) {
  activeIndex.value = index
  await nextTick()
  optionButtons()[index]?.focus()
}

async function openMenu(index = selectedIndex.value) {
  if (props.disabled || !props.options.length) return
  const indexes = enabledIndexes()
  const target = indexes.includes(index) ? index : indexes[0] ?? -1
  open.value = true
  if (target >= 0) await focusOption(target)
}

function closeMenu(returnFocus = false) {
  open.value = false
  activeIndex.value = -1
  if (returnFocus) void nextTick(() => trigger.value?.focus())
}

function toggleMenu() {
  if (open.value) closeMenu(true)
  else void openMenu()
}

function selectOption(option: FilterSelectOption) {
  if (option.disabled) return
  model.value = option.value
  closeMenu(true)
}

function onOptionPointerDown(event: PointerEvent) {
  // Keep the trigger focused while the menu closes so the option click is not
  // lost to the root focusout handler in browsers that move focus on pointerdown.
  if (event.button === 0 && event.pointerType !== 'touch') event.preventDefault()
}

function move(current: number, step: 1 | -1) {
  const indexes = enabledIndexes()
  if (!indexes.length) return
  const position = indexes.indexOf(current)
  const next = position < 0
    ? (step === 1 ? 0 : indexes.length - 1)
    : (position + step + indexes.length) % indexes.length
  void focusOption(indexes[next]!)
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const indexes = enabledIndexes()
    const fallback = event.key === 'ArrowDown' ? indexes[0] : indexes.at(-1)
    void openMenu(selectedIndex.value >= 0 ? selectedIndex.value : fallback)
  }
  else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    closeMenu(true)
  }
}

function onOptionKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(index, event.key === 'ArrowDown' ? 1 : -1)
  }
  else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const indexes = enabledIndexes()
    const target = event.key === 'Home' ? indexes[0] : indexes.at(-1)
    if (target !== undefined) void focusOption(target)
  }
  else if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu(true)
  }
  else if (event.key === 'Tab') {
    closeMenu()
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) closeMenu()
}

function onFocusOut() {
  void nextTick(() => {
    if (root.value && !root.value.contains(document.activeElement)) closeMenu()
  })
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))
</script>

<template>
  <div ref="root" class="app-filter-select" :class="{ 'is-open': open, 'is-disabled': disabled }" @focusout="onFocusOut">
    <button
      ref="trigger"
      class="app-filter-select__trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown="onTriggerKeydown"
    >
      <span>{{ selectedLabel }}</span>
      <IconChevronDown class="app-filter-select__chevron" :size="15" :stroke-width="1.8" aria-hidden="true" />
    </button>

    <div v-if="open" :id="listboxId" class="app-filter-select__menu" role="listbox" :aria-label="label">
      <button
        v-for="(option, index) in options"
        :key="option.value"
        class="app-filter-select__option"
        :class="{ 'is-active': activeIndex === index }"
        type="button"
        role="option"
        :aria-selected="model === option.value"
        :disabled="option.disabled"
        @pointerdown.stop="onOptionPointerDown"
        @click.stop="selectOption(option)"
        @focus="activeIndex = index"
        @keydown="onOptionKeydown($event, index)"
      >
        <span>{{ option.label }}</span>
        <IconCheck v-if="model === option.value" :size="14" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.app-filter-select { position: relative; min-width: 0; width: 100%; }
.app-filter-select__trigger { width: 100%; min-height: 2.45rem; padding: 0 .7rem 0 .75rem; border: 1px solid var(--hub-line); border-radius: var(--hub-radius-md); display: flex; align-items: center; justify-content: space-between; gap: .75rem; color: var(--hub-text-muted); background: var(--hub-input-bg); font-size: .78rem; line-height: var(--hub-leading-control); text-align: left; backdrop-filter: var(--hub-blur-control); cursor: pointer; }
.app-filter-select__trigger:hover { border-color: var(--hub-line-strong); color: var(--hub-text); background: var(--hub-glass-hover); }
.app-filter-select__trigger:focus-visible { border-color: var(--hub-accent-line); outline: 2px solid var(--hub-accent-soft); outline-offset: 1px; color: var(--hub-text); }
.app-filter-select__trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-filter-select__chevron { flex: 0 0 auto; color: var(--hub-text-faint); }
.is-open .app-filter-select__chevron { color: var(--hub-accent-text); transform: rotate(180deg); }
.app-filter-select__menu { position: absolute; z-index: var(--hub-z-tooltip); top: calc(100% + .4rem); left: 0; width: max(100%, 10.5rem); max-height: 16rem; padding: .3rem; overflow-y: auto; border: 1px solid var(--hub-line-strong); border-radius: var(--hub-radius-lg); background: color-mix(in srgb, var(--hub-solid-surface-strong) 96%, transparent); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); backdrop-filter: var(--hub-blur-control); scrollbar-width: thin; }
.app-filter-select__option { width: 100%; min-height: 2.3rem; padding: .45rem .55rem .45rem .65rem; border: 0; border-radius: var(--hub-radius-sm); display: grid; grid-template-columns: minmax(0, 1fr) 1rem; align-items: center; gap: .65rem; color: var(--hub-text-muted); background: transparent; font-size: .76rem; line-height: var(--hub-leading-control); text-align: left; cursor: pointer; }
.app-filter-select__option:hover, .app-filter-select__option:focus-visible, .app-filter-select__option.is-active { outline: 0; color: var(--hub-text); background: var(--hub-glass-hover); }
.app-filter-select__option[aria-selected='true'] { color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.app-filter-select__option svg { color: var(--hub-accent-text); }
.app-filter-select__option:disabled { color: var(--hub-text-disabled); cursor: not-allowed; }
.app-filter-select.is-disabled { opacity: .58; }
</style>
