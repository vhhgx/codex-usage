<script setup lang="ts">
import { IconX } from '@tabler/icons-vue'

const props = withDefaults(defineProps<{
  open: boolean
  kicker?: string
  title: string
  labelledBy?: string
  wide?: boolean
}>(), { kicker: '' })

const emit = defineEmits<{ close: [] }>()
const generatedTitleId = `app-drawer-title-${useId().replaceAll(':', '')}`
const titleId = computed(() => props.labelledBy || generatedTitleId)
const drawer = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let previouslyFocused: HTMLElement | null = null
let bodyLockHeld = false
let backgroundInertCount = 0
let backgroundRoot: HTMLElement | null = null
let backgroundWasInert = false
let backgroundAriaHidden: string | null = null
let backgroundInertHeld = false

function close() { emit('close') }

function isTopmost() {
  if (!drawer.value || !import.meta.client) return false
  const openDrawers = [...document.querySelectorAll<HTMLElement>('.app-drawer-backdrop .app-drawer')]
  return openDrawers.at(-1) === drawer.value
}

function focusableElements() {
  return [...drawer.value?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || []].filter(element => {
    if (element.closest('[inert]')) return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
}

function lockBody() {
  if (bodyLockHeld || !import.meta.client) return
  const count = Number(document.body.dataset.appDrawerCount || 0) + 1
  document.body.dataset.appDrawerCount = String(count)
  document.body.classList.add('app-drawer-open')
  bodyLockHeld = true
}

function unlockBody() {
  if (!bodyLockHeld || !import.meta.client) return
  const count = Math.max(0, Number(document.body.dataset.appDrawerCount || 1) - 1)
  if (count) document.body.dataset.appDrawerCount = String(count)
  else {
    delete document.body.dataset.appDrawerCount
    document.body.classList.remove('app-drawer-open')
  }
  bodyLockHeld = false
}

function lockBackground() {
  if (backgroundInertHeld || !import.meta.client) return
  const root = document.querySelector<HTMLElement>('#__nuxt')
  if (!root) return
  if (backgroundInertCount === 0) {
    backgroundRoot = root
    backgroundWasInert = root.inert
    backgroundAriaHidden = root.getAttribute('aria-hidden')
  }
  backgroundInertCount += 1
  root.inert = true
  root.setAttribute('aria-hidden', 'true')
  backgroundInertHeld = true
}

function unlockBackground() {
  if (!backgroundInertHeld || !import.meta.client) return
  backgroundInertCount = Math.max(0, backgroundInertCount - 1)
  if (!backgroundInertCount && backgroundRoot) {
    backgroundRoot.inert = backgroundWasInert
    if (backgroundAriaHidden === null) backgroundRoot.removeAttribute('aria-hidden')
    else backgroundRoot.setAttribute('aria-hidden', backgroundAriaHidden)
    backgroundRoot = null
    backgroundAriaHidden = null
  }
  backgroundInertHeld = false
}

async function syncOpenState(open: boolean) {
  if (!import.meta.client) return
  if (open) {
    if (!previouslyFocused) previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    lockBody()
    lockBackground()
    await nextTick()
    closeButton.value?.focus()
  } else {
    unlockBody()
    unlockBackground()
    await restoreFocus()
  }
}

async function restoreFocus() {
  if (!import.meta.client) return
  const target = previouslyFocused
  previouslyFocused = null
  if (!target) return
  await nextTick()
  if (!document.contains(target)) return
  // A nested drawer may close while its trigger remains inside a parent
  // drawer. Restore focus there; skip it only when another drawer replaced a
  // trigger that lived outside the remaining modal.
  const targetDrawer = target.closest('.app-drawer')
  if (targetDrawer || !document.querySelector('.app-drawer-backdrop .app-drawer')) target.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open || !isTopmost()) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, open => { void syncOpenState(open) }, { immediate: true })
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (props.open) void syncOpenState(true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unlockBody()
  unlockBackground()
  void restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="app-drawer-backdrop" @click.self="close">
      <aside ref="drawer" class="app-drawer" :class="{ 'app-drawer--wide': wide }" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="app-drawer__header">
          <div>
            <span v-if="kicker">{{ kicker }}</span>
            <h2 :id="titleId">{{ title }}</h2>
          </div>
          <button ref="closeButton" class="icon-button" type="button" title="关闭" aria-label="关闭" @click="close"><IconX :size="18" /></button>
        </header>
        <div class="app-drawer__body"><slot /></div>
      </aside>
    </div>
  </Teleport>
</template>

<style>
.app-drawer-backdrop { position:fixed; inset:0; z-index:var(--hub-z-modal); display:grid; place-items:stretch end; background:var(--hub-overlay-scrim); backdrop-filter:var(--hub-blur-overlay, blur(3px)); }
.app-drawer { width:min(720px, 100vw); height:100dvh; display:grid; grid-template-rows:auto minmax(0, 1fr); overflow:hidden; color:var(--hub-text); background:var(--hub-solid-surface-strong); border-left:1px solid var(--hub-line-strong); box-shadow:var(--hub-panel-shadow); animation:app-drawer-in 180ms ease-out both; }
.app-drawer--wide { width:min(960px, 100vw); }
.app-drawer__header { min-height:72px; padding:0 1.25rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--hub-line); background:color-mix(in srgb, var(--hub-solid-surface-strong) 88%, transparent); backdrop-filter:var(--hub-blur-panel); }
.app-drawer__header > div { min-width:0; display:grid; gap:.25rem; }
.app-drawer__header span { color:var(--hub-accent-text); font:600 .62rem/1 var(--hub-font-mono); letter-spacing:.08em; }
.app-drawer__header h2 { margin:0; color:var(--hub-text); font-size:1.05rem; font-weight:var(--hub-weight-semibold); }
.app-drawer__body { min-height:0; overflow-y:auto; padding:1.15rem 1.25rem 1.35rem; }
.app-drawer__body > .admin-form { min-height:100%; display:flex; flex-direction:column; }
.app-drawer__body > .admin-form > footer { margin-top:auto; padding-top:1.15rem; }
@keyframes app-drawer-in { from { opacity:0; transform:translateX(24px); } to { opacity:1; transform:translateX(0); } }
@media (prefers-reduced-motion:reduce) { .app-drawer { animation:none; } }
@media (max-width:600px) { .app-drawer__header { min-height:64px; padding-inline:1rem; } .app-drawer__body { padding:1rem; } }
</style>
