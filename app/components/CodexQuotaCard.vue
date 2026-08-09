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
  scheduleStatus?: 'available' | 'paused'
}>()

defineEmits<{ refresh: [id: string] }>()

const primaryWindow = computed(() =>
  props.quota?.windows.find((window) => window.kind === 'five-hour') || props.quota?.windows[0]
)

const secondaryWindow = computed(() =>
  props.quota?.windows.find((window) => window.kind === 'weekly' || window.kind === 'monthly') ||
  props.quota?.windows.find((window) => window.id !== primaryWindow.value?.id)
)

const extraWindows = computed(() =>
  (props.quota?.windows || []).filter(
    (window) => window.id !== primaryWindow.value?.id && window.id !== secondaryWindow.value?.id
  )
)

const weeklyWindow = computed(() =>
  props.quota?.windows.find((window) => window.kind === 'weekly')
)

const quotaUnavailable = computed(() => {
  const remaining = weeklyWindow.value?.remainingPercent
  return typeof remaining === 'number' && remaining <= 0
})

const cardTone = computed(() => {
  if (quotaUnavailable.value) return 'neutral'
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
  if (!value) return '重置时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
}

function refreshedText(value: number | undefined) {
  if (!value) return '尚未查询'
  return `更新于 ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(value)}`
}

</script>

<template>
  <article class="quota-ticket" :data-tone="cardTone" :data-unavailable="quotaUnavailable">
    <header class="quota-ticket__header">
      <div class="quota-ticket__identity">
        <h2>{{ account.email || account.name }}</h2>
        <div class="quota-ticket__meta">
          <span class="quota-ticket__plan">{{ quota?.planType || account.planType || 'Codex' }}</span>
          <span v-if="quotaUnavailable" class="quota-ticket__state" data-tone="neutral">额度不可用</span>
          <span v-if="scheduleStatus" class="quota-ticket__state" :data-tone="scheduleStatus === 'available' ? 'healthy' : 'warning'">{{ scheduleStatus === 'available' ? '可调度' : '暂停调度' }}</span>
        </div>
      </div>
      <button type="button" class="icon-button quota-ticket__refresh" :disabled="loading" title="刷新此账号" aria-label="刷新此账号" @click="$emit('refresh', account.id)"><IconRefresh :size="14" :stroke-width="1.8" :class="{ 'is-spinning': loading }" /></button>
    </header>

    <div v-if="loading" class="quota-ticket__loading" aria-label="正在读取额度">
      <span class="quota-ticket__loading-main" />
      <span class="quota-ticket__loading-side" />
    </div>

    <div v-else-if="quota?.quotaStatus === 'error'" class="quota-ticket__error">
      <IconAlertTriangle :size="24" :stroke-width="1.7" />
      <div>
        <strong>额度读取失败</strong>
        <p>{{ quota.error }}</p>
      </div>
    </div>

    <div v-else class="quota-ticket__content">
      <section
        class="quota-ticket__primary quota-ticket__window"
        :style="{ '--quota-level': `${primaryWindow?.remainingPercent ?? 0}%` }"
      >
        <div>
          <span class="quota-ticket__window-label">{{ primaryWindow?.label || '5 小时额度' }}</span>
          <div class="quota-ticket__window-number">
            <strong>{{ percent(primaryWindow?.remainingPercent) }}</strong><span>%</span>
          </div>
        </div>
        <div class="quota-ticket__window-reset">
          <strong>{{ resetText(primaryWindow?.resetAt) }}</strong>
        </div>
      </section>

      <section
        class="quota-ticket__secondary quota-ticket__window"
        :style="{ '--quota-level': `${secondaryWindow?.remainingPercent ?? 0}%` }"
      >
        <div>
          <span class="quota-ticket__window-label">{{ secondaryWindow?.label || '每周额度' }}</span>
          <div class="quota-ticket__window-number">
            <strong>{{ percent(secondaryWindow?.remainingPercent) }}</strong><span>%</span>
          </div>
        </div>
        <div class="quota-ticket__window-reset">
          <strong>{{ resetText(secondaryWindow?.resetAt) }}</strong>
        </div>
      </section>
    </div>

    <div v-if="!loading && extraWindows.length" class="quota-ticket__extras">
      <div v-for="window in extraWindows" :key="window.id">
        <span>{{ window.label }}</span>
        <strong>{{ percent(window.remainingPercent) }}%</strong>
      </div>
    </div>

    <footer class="quota-ticket__footer"><span>{{ refreshedText(quota?.refreshedAt) }}</span></footer>
  </article>
</template>

<style scoped>
.quota-ticket { width: auto; min-width: 0; min-height: 0; border: 1px solid var(--hub-line); border-radius: var(--hub-radius-md); display: grid; grid-template-rows: auto auto auto auto; color: var(--hub-text); background: var(--hub-solid-surface-strong); box-shadow: none; }
.quota-ticket[data-tone='healthy'] { border-left: 2px solid var(--hub-success); border-top: 1px solid var(--hub-line); }
.quota-ticket[data-tone='warning'] { border-left: 2px solid var(--hub-warning); border-top: 1px solid var(--hub-line); }
.quota-ticket[data-tone='danger'] { border-left: 2px solid var(--hub-danger); border-top: 1px solid var(--hub-line); }
.quota-ticket[data-tone='neutral'] { border-left: 2px solid var(--hub-line-strong); border-top: 1px solid var(--hub-line); }
.quota-ticket__header { min-height: 50px; padding: var(--hub-space-2) var(--hub-space-3); border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: minmax(0, 1fr) 28px; align-items: center; gap: var(--hub-space-2); }
.quota-ticket__identity { min-width: 0; }
.quota-ticket__identity h2 { overflow: hidden; color: var(--hub-text); font-family: var(--hub-font-mono); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-semibold); text-overflow: ellipsis; white-space: nowrap; }
.quota-ticket__meta { margin-top: 3px; display: flex; align-items: center; gap: var(--hub-space-2); }
.quota-ticket__plan, .quota-ticket__state { color: var(--hub-text-faint); font-size: var(--hub-text-micro); text-transform: none; }
.quota-ticket__state[data-tone='healthy'] { color: var(--hub-success); }
.quota-ticket__state[data-tone='warning'] { color: var(--hub-warning); }
.quota-ticket__refresh { width: 28px; height: 28px; border-radius: var(--hub-radius-sm); }
.quota-ticket__content { min-width: 0; margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.quota-ticket__primary, .quota-ticket__secondary { width: auto; }
.quota-ticket__primary { border-right: 1px solid var(--hub-line-row); }
.quota-ticket__window { min-height: 82px; padding: var(--hub-space-2) var(--hub-space-3); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: var(--hub-space-2); }
.quota-ticket__window::before { content: none; }
.quota-ticket__window > div:first-child { min-width: 0; }
.quota-ticket__window-label { overflow: hidden; display: block; color: var(--hub-text-faint); font-size: var(--hub-text-micro); text-overflow: ellipsis; white-space: nowrap; }
.quota-ticket__window-number { margin-top: 4px; align-items: baseline; }
.quota-ticket__window-number strong { color: var(--hub-text); font-size: var(--hub-text-quota); font-weight: var(--hub-weight-semibold); letter-spacing: 0; line-height: 1; }
.quota-ticket__window-number span { margin: 0 0 0 3px; color: var(--hub-text-faint); font-size: var(--hub-text-xs); }
.quota-ticket__window-reset { padding: 0; border: 0; text-align: right; }
.quota-ticket__window-reset strong { color: var(--hub-text-faint); font-size: var(--hub-text-micro); font-weight: var(--hub-weight-regular); white-space: nowrap; }
.quota-ticket__extras { padding: var(--hub-space-2) var(--hub-space-3); border-top: 1px solid var(--hub-line-row); gap: var(--hub-space-2); }
.quota-ticket__extras div { color: var(--hub-text-faint); font-size: var(--hub-text-micro); }
.quota-ticket__footer { min-height: 30px; padding: 5px var(--hub-space-3); border-top: 1px solid var(--hub-line-row); justify-content: flex-start; }
.quota-ticket__footer > span { color: var(--hub-text-faint); font-size: var(--hub-text-micro); }
.quota-ticket__loading { min-height: 82px; padding: var(--hub-space-3); }
.quota-ticket__loading span { border-radius: var(--hub-radius-sm); background: var(--hub-skeleton); }
.quota-ticket__error { min-height: 82px; padding: var(--hub-space-3); justify-content: flex-start; }
.quota-ticket__error svg { width: 18px; }
.quota-ticket__error strong { color: var(--hub-danger); font-size: var(--hub-text-xs); }
.quota-ticket__error p { margin-top: 3px; color: var(--hub-text-muted); font-size: var(--hub-text-micro); }
@media (max-width: 480px) { .quota-ticket__content { grid-template-columns: 1fr; } .quota-ticket__primary { border-right: 0; border-bottom: 1px solid var(--hub-line-row); } }
</style>
