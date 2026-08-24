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
const titleId = computed(() => props.labelledBy || 'app-drawer-title')

function close() { emit('close') }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="app-drawer-backdrop" @click.self="close">
      <aside class="app-drawer" :class="{ 'app-drawer--wide': wide }" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="app-drawer__header">
          <div>
            <span v-if="kicker">{{ kicker }}</span>
            <h2 :id="titleId">{{ title }}</h2>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="close"><IconX :size="18" /></button>
        </header>
        <div class="app-drawer__body"><slot /></div>
      </aside>
    </div>
  </Teleport>
</template>

<style>
.app-drawer-backdrop { position:fixed; inset:0; z-index:var(--hub-z-modal); display:grid; place-items:stretch end; background:var(--hub-overlay-scrim, rgb(15 19 16 / 56%)); backdrop-filter:var(--hub-blur-overlay, blur(3px)); }
.app-drawer { width:min(720px, 100vw); height:100dvh; display:grid; grid-template-rows:auto minmax(0, 1fr); overflow:hidden; color:var(--hub-text); background:var(--hub-solid-surface-strong); border-left:1px solid var(--hub-line-strong); box-shadow:-24px 0 72px rgb(0 0 0 / 24%); animation:app-drawer-in 180ms ease-out both; }
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
