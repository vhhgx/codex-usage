<script setup lang="ts">
import {
  IconAlertTriangle,
  IconCalendarTime,
  IconRefresh
} from '@tabler/icons-vue'
import type { CodexAccountView, CodexQuotaResult } from '#shared/types/codex'

const props = defineProps<{
  account: CodexAccountView
  quota?: CodexQuotaResult
  loading?: boolean
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
  <article class="quota-ticket" :data-tone="cardTone">
    <header class="quota-ticket__header">
      <div class="quota-ticket__identity">
        <h2>{{ account.email || account.name }}</h2>
      </div>
      <div class="quota-ticket__plan">
        {{ quota?.planType || account.planType || 'Codex' }}
      </div>
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
      <section class="quota-ticket__primary">
        <div class="quota-ticket__metric-label">
          <span>{{ primaryWindow?.label || '5 小时额度' }}</span>
        </div>
        <div class="quota-ticket__number">
          <strong>{{ percent(primaryWindow?.remainingPercent) }}</strong><span>%</span>
        </div>
        <p>当前可用</p>
        <div class="quota-ticket__rule" aria-hidden="true">
          <span :style="{ width: `${primaryWindow?.remainingPercent ?? 0}%` }" />
        </div>
        <div class="quota-ticket__reset">
          <IconCalendarTime :size="18" :stroke-width="1.8" />
          {{ resetText(primaryWindow?.resetAt) }}
        </div>
      </section>

      <section
        class="quota-ticket__secondary"
        :style="{ '--quota-level': `${secondaryWindow?.remainingPercent ?? 0}%` }"
      >
        <div>
          <span class="quota-ticket__secondary-label">{{ secondaryWindow?.label || '每周额度' }}</span>
          <div class="quota-ticket__secondary-number">
            <strong>{{ percent(secondaryWindow?.remainingPercent) }}</strong><span>%</span>
          </div>
        </div>
        <div class="quota-ticket__secondary-reset">
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

    <footer class="quota-ticket__footer">
      <span>{{ refreshedText(quota?.refreshedAt) }}</span>
      <button
        type="button"
        class="button button--quiet button--small"
        :disabled="loading"
        @click="$emit('refresh', account.id)"
      >
        <IconRefresh :size="16" :stroke-width="1.8" :class="{ 'is-spinning': loading }" />
        刷新此账号
      </button>
    </footer>
  </article>
</template>
