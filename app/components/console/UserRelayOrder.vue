<script setup lang="ts">
import { IconChevronLeft, IconChevronRight, IconGripVertical, IconPackage, IconServerBolt, IconUserShield } from '@tabler/icons-vue'

interface RelayOrderItem {
  id: string
  sourceId: string | null
  sourceType: 'package' | 'private_pool' | 'user_relay'
  name: string
  enabled: boolean
  healthStatus: string
  circuitState: 'closed' | 'open' | 'half_open'
  lastHealthCheckAt: number | null
}

const { data, refresh } = await useFetch<{ sources: RelayOrderItem[] }>('/api/console/relay-order')
const toast = useAppToast()
const orderedIds = ref<string[]>([])
const draggingId = ref<string | null>(null)
const saving = ref(false)
let refreshTimer: number | undefined
let activePointer: { id: string; pointerId: number } | null = null
let pointerStartOrder: string[] = []

const sources = computed(() => orderedIds.value.map(id => data.value?.sources.find(source => source.id === id)).filter((source): source is RelayOrderItem => Boolean(source)))

watch(() => data.value?.sources.map(source => `${source.id}:${source.enabled}:${source.healthStatus}:${source.circuitState}`).join('|'), () => {
  if (!draggingId.value && !saving.value) orderedIds.value = (data.value?.sources || []).map(source => source.id)
}, { immediate: true })

function status(item: RelayOrderItem) {
  if (!item.enabled) return { tone: 'disabled', label: '已停用' }
  if (item.circuitState === 'open') return { tone: 'error', label: '熔断中' }
  if (item.circuitState === 'half_open') return { tone: 'warning', label: '恢复检测' }
  if (item.healthStatus === 'unhealthy') return { tone: 'error', label: '不可用' }
  if (item.healthStatus === 'healthy') return { tone: 'active', label: '可用' }
  if (item.sourceType === 'package' && item.healthStatus === 'unavailable') return { tone: 'disabled', label: '无可用套餐' }
  if (item.sourceType === 'private_pool' && item.healthStatus === 'unavailable') return { tone: 'disabled', label: '暂无可调度账号' }
  return { tone: 'pending', label: '待检测' }
}

async function persist(next: string[]) {
  orderedIds.value = next
  saving.value = true
  try {
    const result = await $fetch<{ sources: RelayOrderItem[] }>('/api/console/relay-order', { method: 'PUT', body: { orderedIds: next } })
    data.value = result
    orderedIds.value = result.sources.map(source => source.id)
    toast.show('故障转移顺序已保存', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '保存顺序失败', 'error')
    await refresh()
    orderedIds.value = (data.value?.sources || []).map(source => source.id)
  } finally { saving.value = false }
}

function reordered(sourceId: string, targetId: string) {
  if (sourceId === targetId) return null
  const next = [...orderedIds.value]
  const sourceIndex = next.indexOf(sourceId)
  const targetIndex = next.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return null
  next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, sourceId)
  return next
}

function startPointerDrag(event: PointerEvent, id: string) {
  if (saving.value || event.button !== 0) return
  event.preventDefault()
  activePointer = { id, pointerId: event.pointerId }
  pointerStartOrder = [...orderedIds.value]
  draggingId.value = id
  window.addEventListener('pointermove', movePointerDrag, { passive: false })
  window.addEventListener('pointerup', finishPointerDrag, { passive: false })
  window.addEventListener('pointercancel', cancelPointerDrag)
}

function movePointerDrag(event: PointerEvent) {
  if (!activePointer || activePointer.pointerId !== event.pointerId) return
  event.preventDefault()
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-relay-order-id]')
  const targetId = target?.dataset.relayOrderId
  if (!targetId || targetId === activePointer.id) return
  const next = reordered(activePointer.id, targetId)
  if (next) orderedIds.value = next
}

function finishPointerDrag(event: PointerEvent) {
  if (!activePointer || activePointer.pointerId !== event.pointerId) return
  event.preventDefault()
  const next = [...orderedIds.value]
  const changed = next.some((id, index) => id !== pointerStartOrder[index])
  removePointerListeners()
  activePointer = null
  pointerStartOrder = []
  draggingId.value = null
  if (changed) void persist(next)
}

function cancelPointerDrag(event: PointerEvent) {
  if (!activePointer || activePointer.pointerId !== event.pointerId) return
  orderedIds.value = pointerStartOrder
  removePointerListeners()
  activePointer = null
  pointerStartOrder = []
  draggingId.value = null
}

function removePointerListeners() {
  window.removeEventListener('pointermove', movePointerDrag)
  window.removeEventListener('pointerup', finishPointerDrag)
  window.removeEventListener('pointercancel', cancelPointerDrag)
}

function move(id: string, offset: number) {
  const index = orderedIds.value.indexOf(id)
  const target = orderedIds.value[index + offset]
  if (!target) return
  const next = reordered(id, target)
  if (next) void persist(next)
}

async function refreshStatus() {
  if (!draggingId.value && !saving.value) await refresh()
}

onMounted(() => {
  window.addEventListener('user-relays-changed', refreshStatus)
  refreshTimer = window.setInterval(refreshStatus, 10_000)
})
onBeforeUnmount(() => {
  window.removeEventListener('user-relays-changed', refreshStatus)
  removePointerListeners()
  if (refreshTimer) window.clearInterval(refreshTimer)
})
</script>

<template>
  <section v-if="sources.length" class="relay-order" aria-labelledby="relay-order-title">
    <header><div><span class="admin-kicker">FAILOVER ORDER</span><h2 id="relay-order-title" class="text-balance">故障转移顺序</h2></div><small>{{ saving ? '保存中…' : `${sources.length} 个来源` }}</small></header>
    <div class="relay-order__track">
      <article
        v-for="(item, index) in sources"
        :key="item.id"
        class="relay-order__item"
        :class="{ 'is-dragging': draggingId === item.id }"
        :data-tone="status(item).tone"
        :aria-label="`第 ${index + 1} 位：${item.name}`"
        :aria-grabbed="draggingId === item.id"
        :data-relay-order-id="item.id"
        :data-source-type="item.sourceType"
      >
        <div class="relay-order__rank tabular-nums">{{ String(index + 1).padStart(2, '0') }}</div>
        <div class="relay-order__body">
          <div><IconPackage v-if="item.sourceType === 'package'" :size="16" /><IconUserShield v-else-if="item.sourceType === 'private_pool'" :size="16" /><IconServerBolt v-else :size="16" /><strong class="truncate">{{ item.name }}</strong></div>
          <span><i />{{ status(item).label }}</span>
        </div>
        <div class="relay-order__actions">
          <button class="icon-button" type="button" title="向前移动" :aria-label="`${item.name} 向前移动`" :disabled="saving || index === 0" @click="move(item.id, -1)"><IconChevronLeft :size="15" /></button>
          <button
            class="icon-button relay-order__grip"
            type="button"
            title="拖动调整顺序"
            :aria-label="`拖动 ${item.name} 调整顺序`"
            :disabled="saving"
            @pointerdown="startPointerDrag($event, item.id)"
          ><IconGripVertical :size="17" /></button>
          <button class="icon-button" type="button" title="向后移动" :aria-label="`${item.name} 向后移动`" :disabled="saving || index === sources.length - 1" @click="move(item.id, 1)"><IconChevronRight :size="15" /></button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.relay-order { min-width:0; margin-bottom:1rem; border-block:1px solid var(--hub-line); background:var(--hub-solid-surface); }
.relay-order > header { min-height:58px; padding:.75rem 1rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--hub-line-row); }
.relay-order > header h2 { margin-top:.2rem; font-size:.95rem; }
.relay-order > header small { color:var(--hub-text-faint); font-size:.68rem; font-variant-numeric:tabular-nums; }
.relay-order__track { min-width:0; padding:.75rem; display:flex; flex-wrap:nowrap; gap:.6rem; overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:thin; }
.relay-order__item { width:220px; min-height:92px; flex:0 0 220px; display:grid; grid-template-columns:32px minmax(0,1fr); grid-template-rows:1fr auto; gap:.55rem; padding:.7rem; border:1px solid var(--hub-line); border-radius:7px; background:var(--hub-solid-surface-hover); cursor:grab; user-select:none; }
.relay-order__item:active { cursor:grabbing; }
.relay-order__item.is-dragging { opacity:.45; }
.relay-order__rank { grid-row:1 / -1; display:grid; place-items:start center; padding-top:.15rem; color:var(--hub-accent); font-family:var(--font-mono); font-size:.72rem; font-weight:800; }
.relay-order__body { min-width:0; display:grid; align-content:start; gap:.35rem; }
.relay-order__body > div { min-width:0; display:flex; align-items:center; gap:.4rem; }
.relay-order__body > div svg { flex:none; color:var(--hub-accent); }
.relay-order__body strong { min-width:0; font-size:.78rem; }
.relay-order__body > span { display:flex; align-items:center; gap:.35rem; color:var(--hub-text-muted); font-size:.68rem; }
.relay-order__body > span i { width:6px; height:6px; border-radius:50%; background:var(--hub-text-faint); }
[data-tone="active"] .relay-order__body > span i { background:#1a8b62; }
.relay-order__actions { grid-column:2; display:flex; align-items:center; justify-content:flex-end; gap:.2rem; }
.relay-order__actions .icon-button { width:28px; height:28px; }
.relay-order__grip { color:var(--hub-text-faint); cursor:grab; touch-action:none; }
.relay-order__grip:active { cursor:grabbing; }
@media (max-width:600px) { .relay-order__item { width:210px; flex-basis:210px; } }
</style>
