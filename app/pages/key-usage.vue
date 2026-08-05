<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
import {
  IconAlertTriangle,
  IconBolt,
  IconCalendarTime,
  IconChartBar,
  IconCircleCheck,
  IconCoin,
  IconDatabase,
  IconGauge,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader2,
  IconRefresh,
  IconSend
} from '@tabler/icons-vue'
import type {
  UsageRange,
  UsageSource,
  UserQuotaSummary,
  UserUsageResponse
} from '#shared/types/usage'
import { formatTokenCount } from '#shared/utils/number-format'

useSeoMeta({ title: 'API Key 用量查询 | Zephyr Console' })

const apiKey = ref('')
const source = useState<UsageSource>('key-usage-source', () => 'cpa')
const range = useState<UsageRange>('key-usage-range', () => '7d')
const loading = ref(false)
const error = ref('')
const result = useState<UserUsageResponse | null>('key-usage-result', () => null)
const hasCachedKey = ref(false)
const showApiKey = ref(false)
const SOURCE_CACHE_KEY = 'zephyr-console:usage-source'
const API_KEY_CACHE_PREFIX = 'zephyr-console:user-api-key'
const LEGACY_CPA_KEY_CACHE = 'cpa-plus-console:user-api-key'

const sources: Array<{ value: UsageSource; label: string }> = [
  { value: 'cpa', label: 'CPA' },
  { value: 'sub2api', label: 'Sub2API' }
]

const ranges: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' }
]

function number(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function cost(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2
  }).format(value)
}

function money(value: number | null, unit = 'USD') {
  if (value === null) return '不限'
  if (unit.toUpperCase() === 'USD') return cost(value)
  return `${number(value)} ${unit}`
}

function timestamp(value: number | null) {
  if (value === null) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
}

function quotaPercent(used: number, limit: number) {
  return limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0
}

function quotaStatus(status: string, isValid: boolean) {
  if (!isValid) return '不可用'
  const labels: Record<string, string> = {
    active: '正常',
    quota_exhausted: '额度耗尽',
    expired: '已过期'
  }
  return labels[status] || status
}

function quotaIsHealthy(quota: UserQuotaSummary) {
  return quota.isValid && quota.status === 'active' && quota.remaining !== 0
}

function cacheKey(value: UsageSource) {
  return `${API_KEY_CACHE_PREFIX}:${value}`
}

function readCachedKey(value: UsageSource) {
  return localStorage.getItem(cacheKey(value)) ||
    (value === 'cpa' ? localStorage.getItem(LEGACY_CPA_KEY_CACHE) : '') ||
    ''
}

function errorMessage(value: unknown) {
  const status = value as { data?: { message?: string; statusMessage?: string }; statusMessage?: string; message?: string }
  return status.data?.message || status.data?.statusMessage || status.statusMessage || status.message || '查询失败，请稍后重试'
}

async function submit() {
  if (!apiKey.value.trim() || loading.value) return
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await $fetch<UserUsageResponse>('/api/usage/query', {
      method: 'POST',
      body: { apiKey: apiKey.value, range: range.value, source: source.value }
    })
    localStorage.setItem(cacheKey(source.value), apiKey.value.trim())
    localStorage.setItem(SOURCE_CACHE_KEY, source.value)
    hasCachedKey.value = true
  } catch (value) {
    error.value = errorMessage(value)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  const cachedSource = localStorage.getItem(SOURCE_CACHE_KEY)
  if (cachedSource === 'cpa' || cachedSource === 'sub2api') source.value = cachedSource
  apiKey.value = readCachedKey(source.value)
  hasCachedKey.value = Boolean(apiKey.value)
})

watch(source, (nextSource) => {
  if (!import.meta.client) return
  apiKey.value = readCachedKey(nextSource)
  hasCachedKey.value = Boolean(apiKey.value)
  result.value = null
  error.value = ''
  localStorage.setItem(SOURCE_CACHE_KEY, nextSource)
})
</script>

<template>
  <div class="usage-page page-width">
    <section class="page-heading">
      <div>
        <span class="eyebrow">SELF SERVICE</span>
        <h1>查询我的 API 用量</h1>
      </div>
    </section>

    <form class="usage-query" @submit.prevent="submit">
      <fieldset class="source-picker range-picker">
        <legend>数据源</legend>
        <label v-for="item in sources" :key="item.value">
          <input v-model="source" type="radio" name="source" :value="item.value">
          <span>{{ item.label }}</span>
        </label>
      </fieldset>

      <div class="field-group field-group--grow">
        <label for="api-key">客户端 API Key</label>
        <div class="secure-input">
          <IconKey :size="19" :stroke-width="1.7" />
          <input
            id="api-key"
            v-model="apiKey"
            name="api-key"
            :type="showApiKey ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            :placeholder="source === 'sub2api' ? '输入 Sub2API API Key' : '输入你调用 CPA 时使用的 API Key'"
            required
          >
          <button
            class="secure-input__toggle"
            type="button"
            :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
            :title="showApiKey ? '隐藏 API Key' : '显示 API Key'"
            @click="showApiKey = !showApiKey"
          >
            <IconEyeOff v-if="showApiKey" :size="18" :stroke-width="1.8" />
            <IconEye v-else :size="18" :stroke-width="1.8" />
          </button>
        </div>
      </div>

      <fieldset class="range-picker">
        <legend>时间范围</legend>
        <label v-for="item in ranges" :key="item.value">
          <input v-model="range" type="radio" name="range" :value="item.value">
          <span>{{ item.label }}</span>
        </label>
      </fieldset>

      <button class="button button--primary usage-query__submit" type="submit" :disabled="loading || !apiKey.trim()">
        <IconLoader2 v-if="loading" class="is-spinning" :size="18" :stroke-width="1.8" />
        <IconRefresh v-else-if="hasCachedKey" :size="18" :stroke-width="1.8" />
        <IconSend v-else :size="18" :stroke-width="1.8" />
        {{ loading ? '正在查询' : hasCachedKey ? '刷新用量' : '查询用量' }}
      </button>
    </form>

    <InlineNotice v-if="error" tone="error" title="无法完成查询" :message="error" />

    <section v-if="result" class="usage-results">
      <section
        v-if="result.quota && result.quota.mode !== 'balance'"
        class="quota-overview"
        :data-tone="quotaIsHealthy(result.quota) ? 'healthy' : 'danger'"
      >
        <header class="quota-overview__header">
          <div>
            <span>SUB2API QUOTA</span>
            <h2>{{ result.quota.planName }}</h2>
          </div>
          <div class="quota-status" :data-active="quotaIsHealthy(result.quota)">
            <IconCircleCheck v-if="quotaIsHealthy(result.quota)" :size="17" :stroke-width="1.8" />
            <IconAlertTriangle v-else :size="17" :stroke-width="1.8" />
            {{ quotaStatus(result.quota.status, result.quota.isValid) }}
          </div>
        </header>

        <div class="quota-overview__body">
          <div class="quota-balance">
            <IconGauge :size="22" :stroke-width="1.6" />
            <span>当前可用额度</span>
            <strong>{{ money(result.quota.remaining, result.quota.unit) }}</strong>
            <small>{{ result.quota.mode === 'quota_limited' ? 'API Key 独立额度' : '订阅额度' }}</small>
          </div>

          <div v-if="result.quota.limits.length" class="quota-limits">
            <div v-for="limit in result.quota.limits" :key="limit.id" class="quota-limit">
              <div class="quota-limit__meta">
                <span>{{ limit.label }}</span>
                <strong>{{ quotaPercent(limit.used, limit.limit).toFixed(1) }}%</strong>
              </div>
              <div class="quota-limit__track" aria-hidden="true">
                <span :style="{ width: `${quotaPercent(limit.used, limit.limit)}%` }" />
              </div>
              <div class="quota-limit__values">
                <span>已用 {{ money(limit.used, result.quota.unit) }}</span>
                <span>共 {{ money(limit.limit, result.quota.unit) }}</span>
              </div>
              <small v-if="limit.resetAt"><IconCalendarTime :size="14" /> {{ timestamp(limit.resetAt) }} 重置</small>
            </div>
          </div>
        </div>

        <footer v-if="result.quota.expiresAt" class="quota-overview__footer">
          <IconCalendarTime :size="16" :stroke-width="1.7" />
          有效期至 {{ timestamp(result.quota.expiresAt) }}
          <span v-if="result.quota.daysUntilExpiry !== null">（剩余 {{ result.quota.daysUntilExpiry }} 天）</span>
        </footer>
      </section>

      <div class="metric-ribbon">
        <article>
          <IconBolt :size="20" :stroke-width="1.7" />
          <span>调用次数</span>
          <strong>{{ number(result.summary.calls) }}</strong>
          <small>{{ result.summary.successRate === null ? '上游未提供成功率' : `成功率 ${result.summary.successRate.toFixed(1)}%` }}</small>
        </article>
        <article>
          <IconDatabase :size="20" :stroke-width="1.7" />
          <span>总 Token</span>
          <strong>{{ formatTokenCount(result.summary.totalTokens) }}</strong>
          <small>缓存 {{ formatTokenCount(result.summary.cachedTokens) }}</small>
        </article>
        <article>
          <IconCoin :size="20" :stroke-width="1.7" />
          <span>估算费用</span>
          <strong>{{ cost(result.summary.estimatedCost) }}</strong>
          <small>仅供用量分析参考</small>
        </article>
        <article>
          <IconChartBar :size="20" :stroke-width="1.7" />
          <span>平均延迟</span>
          <strong>{{ result.summary.averageLatencyMs === null ? '-' : `${Math.round(result.summary.averageLatencyMs)} ms` }}</strong>
          <small>{{ result.summary.failedCalls === null ? '当前查询范围' : `失败 ${number(result.summary.failedCalls)} 次` }}</small>
        </article>
      </div>

      <div class="results-grid">
        <section class="data-panel data-panel--timeline">
          <header><h2>Token 趋势</h2><span>{{ ranges.find(item => item.value === result?.range)?.label }}</span></header>
          <UsageTimeline :points="result.timeline" />
        </section>

        <section class="data-panel token-breakdown">
          <header><h2>Token 构成</h2></header>
          <dl>
            <div><dt>输入</dt><dd>{{ formatTokenCount(result.summary.inputTokens) }}</dd></div>
            <div><dt>输出</dt><dd>{{ formatTokenCount(result.summary.outputTokens) }}</dd></div>
            <div><dt>推理</dt><dd>{{ formatTokenCount(result.summary.reasoningTokens) }}</dd></div>
            <div><dt>缓存</dt><dd>{{ formatTokenCount(result.summary.cachedTokens) }}</dd></div>
          </dl>
        </section>
      </div>

      <section class="data-panel model-panel">
        <header><h2>模型用量</h2><span>{{ result.models.length }} 个模型</span></header>
        <div v-if="result.models.length" class="model-table-wrap">
          <table class="model-table">
            <thead><tr><th>模型</th><th>调用</th><th>成功率</th><th>Token</th><th>估算费用</th></tr></thead>
            <tbody>
              <tr v-for="model in result.models" :key="model.model">
                <td><code>{{ model.model }}</code></td>
                <td>{{ number(model.calls) }}</td>
                <td>{{ model.successRate === null ? '-' : `${model.successRate.toFixed(1)}%` }}</td>
                <td>{{ formatTokenCount(model.totalTokens) }}</td>
                <td>{{ cost(model.estimatedCost) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="chart-empty">当前时间范围没有模型用量数据</div>
      </section>
    </section>
  </div>
</template>
