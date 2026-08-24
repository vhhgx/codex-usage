<script setup lang="ts">
import {
  IconAlertTriangle,
  IconRefresh
} from '@tabler/icons-vue'
import type { CodexAccountView, CodexQuotaResult } from '#shared/types/codex'

const props = defineProps<{
  account: CodexAccountView
  quota?: CodexQuotaResult
  loading?: boolean
  badge?: string
}>()

defineEmits<{ refresh: [id: string] }>()

const primaryWindow = computed(() =>
  props.quota?.windows.find(window => window.kind === 'five-hour') || props.quota?.windows[0]
)

const secondaryWindow = computed(() =>
  props.quota?.windows.find(window => window.kind === 'weekly' || window.kind === 'monthly') ||
  props.quota?.windows.find(window => window.id !== primaryWindow.value?.id)
)

const cardTone = computed(() => {
  const values = [primaryWindow.value?.remainingPercent, secondaryWindow.value?.remainingPercent]
    .filter((value): value is number => typeof value === 'number')
  const minimum = values.length ? Math.min(...values) : null
  if (minimum === null) return 'neutral'
  if (minimum <= 15) return 'danger'
  if (minimum <= 40) return 'warning'
  return 'healthy'
})

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? '--' : String(Math.round(value))
}

function resetText(value: number | null | undefined) {
  if (!value) return '恢复时间未知'
  return `${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)} 恢复`
}

function updateSpotlight(event: PointerEvent) {
  if (!window.matchMedia('(min-width: 961px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches
    || window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return
  const element = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  element.style.setProperty('--spot-x', `${event.clientX - rect.left}px`)
  element.style.setProperty('--spot-y', `${event.clientY - rect.top}px`)
}
</script>

<template>
  <article class="glass-panel quota-ticket spotlight-panel" :data-tone="cardTone" @pointermove="updateSpotlight">
    <header class="quota-ticket__header">
      <div class="quota-ticket__identity"><h4>{{ account.email || account.name }}</h4><small v-if="badge">{{ badge }}</small></div>
      <button type="button" class="icon-button quota-ticket__refresh" :disabled="loading" title="刷新此账号" :aria-label="`刷新 ${account.email || account.name} 额度`" @click="$emit('refresh', account.id)"><IconRefresh :size="14" :stroke-width="1.8" :class="{ 'is-spinning': loading }" /></button>
    </header>

    <div v-if="loading" class="quota-ticket__windows quota-ticket__loading" aria-label="正在读取额度"><span /><span /></div>
    <div v-else-if="quota?.quotaStatus === 'error'" class="quota-ticket__error"><IconAlertTriangle :size="16" :stroke-width="1.7" /><div><strong>额度读取失败</strong><p>{{ quota.error || '未知错误' }}</p></div></div>
    <div v-else class="quota-ticket__windows">
      <section class="quota-window"><span class="quota-window__label">{{ primaryWindow?.label || '5 小时额度' }}</span><div class="quota-window__number"><strong>{{ percent(primaryWindow?.remainingPercent) }}</strong><span>%</span></div><div class="quota-window__reset">{{ resetText(primaryWindow?.resetAt) }}</div></section>
      <section class="quota-window"><span class="quota-window__label">{{ secondaryWindow?.label || '每周额度' }}</span><div class="quota-window__number"><strong>{{ percent(secondaryWindow?.remainingPercent) }}</strong><span>%</span></div><div class="quota-window__reset">{{ resetText(secondaryWindow?.resetAt) }}</div></section>
    </div>
  </article>
</template>

<style scoped>
.quota-ticket { width: auto; min-width: 0; min-height: 0; padding: .68rem .75rem; display: grid; gap: .55rem; overflow: hidden; }
.quota-ticket[data-tone] { border-top: 1px solid var(--hub-line); }
.quota-ticket__header { min-width: 0; min-height: 0; padding: 0; border-bottom: 0; display: flex; grid-template-columns: none; align-content: normal; align-items: center; justify-content: space-between; gap: .55rem; }
.quota-ticket__identity { min-width: 0; }
.quota-ticket__identity h4 { margin: 0; overflow: hidden; color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .8rem; font-weight: var(--hub-weight-semibold); text-overflow: ellipsis; white-space: nowrap; }
.quota-ticket__identity small { margin-top:.14rem; display:block; color:var(--hub-accent); font-size:.61rem; }
.quota-ticket__refresh { width: var(--hub-icon-button-size-compact); height: var(--hub-icon-button-size-compact); border-radius: var(--hub-radius-md); }
.quota-ticket__windows { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.quota-window { min-width: 0; padding: .12rem .55rem .08rem 0; }
.quota-window + .quota-window { padding-right: 0; padding-left: .65rem; border-left: 1px solid var(--hub-line); }
.quota-window__label { overflow: hidden; display: block; color: var(--hub-text-faint); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.quota-window__number { margin-top: .18rem; display: flex; align-items: baseline; gap: .14rem; font-family: var(--hub-font-mono); }
.quota-window__number strong { color: var(--hub-text); font-size: 1.35rem; font-weight: var(--hub-weight-medium); line-height: 1.54; }
.quota-window__number span { color: var(--hub-text-faint); font-size: .72rem; }
.quota-window__reset { margin-top: .12rem; overflow: hidden; color: var(--hub-text-faint); font-size: .65rem; text-overflow: ellipsis; white-space: nowrap; }
.quota-ticket[data-tone='warning'] .quota-window__number strong { color: var(--hub-warning); }
.quota-ticket[data-tone='danger'] .quota-window__number strong { color: var(--hub-danger); }
.quota-ticket[data-tone='neutral'] .quota-window__number strong { color: var(--hub-text-faint); }
.quota-ticket__error { min-width: 0; min-height: 0; padding: .42rem .5rem; border: 1px dashed var(--hub-danger-line); border-radius: var(--hub-radius-md); display: flex; flex: none; align-items: center; justify-content: flex-start; gap: .45rem; color: var(--hub-danger); background: var(--hub-danger-soft); font-size: .7rem; }
.quota-ticket__error div { min-width: 0; }
.quota-ticket__error strong { font-size: .7rem; }
.quota-ticket__error p { margin-top: .12rem; overflow: hidden; color: var(--hub-text-muted); font-size: .65rem; text-overflow: ellipsis; white-space: nowrap; }
.quota-ticket__loading { min-height: 64px; padding: 0; gap: var(--hub-space-2); }
.quota-ticket__loading span { border-radius: var(--hub-radius-md); background: var(--hub-skeleton); }
</style>
