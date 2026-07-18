<script setup lang="ts">
import {
  IconBolt,
  IconChartBar,
  IconCoin,
  IconDatabase,
  IconKey,
  IconLoader2,
  IconRefresh,
  IconSend
} from '@tabler/icons-vue'
import type { UsageRange, UserUsageResponse } from '#shared/types/usage'

useSeoMeta({ title: '查询 API Key 用量 | Zephyr Console' })

const apiKey = ref('')
const range = ref<UsageRange>('7d')
const loading = ref(false)
const error = ref('')
const result = ref<UserUsageResponse | null>(null)
const hasCachedKey = ref(false)
const API_KEY_CACHE_KEY = 'cpa-plus-console:user-api-key'

const ranges: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' }
]

function number(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function tokenNumber(value: number) {
  const absolute = Math.abs(value)
  const format = (divisor: number, suffix: string) => {
    const scaled = value / divisor
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
    return `${scaled.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, '')}${suffix}`
  }
  if (absolute >= 1_000_000_000) return format(1_000_000_000, 'B')
  if (absolute >= 1_000_000) return format(1_000_000, 'M')
  if (absolute >= 1_000) return format(1_000, 'K')
  return number(value)
}

function cost(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2
  }).format(value)
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
      body: { apiKey: apiKey.value, range: range.value }
    })
    localStorage.setItem(API_KEY_CACHE_KEY, apiKey.value.trim())
    hasCachedKey.value = true
  } catch (value) {
    error.value = errorMessage(value)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  apiKey.value = localStorage.getItem(API_KEY_CACHE_KEY) || ''
  hasCachedKey.value = Boolean(apiKey.value)
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
      <div class="field-group field-group--grow">
        <label for="api-key">客户端 API Key</label>
        <div class="secure-input">
          <IconKey :size="19" :stroke-width="1.7" />
          <input
            id="api-key"
            v-model="apiKey"
            name="api-key"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="输入你调用 CPA 时使用的 API Key"
            required
          >
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
      <div class="metric-ribbon">
        <article>
          <IconBolt :size="20" :stroke-width="1.7" />
          <span>调用次数</span>
          <strong>{{ number(result.summary.calls) }}</strong>
          <small>成功率 {{ result.summary.successRate.toFixed(1) }}%</small>
        </article>
        <article>
          <IconDatabase :size="20" :stroke-width="1.7" />
          <span>总 Token</span>
          <strong>{{ tokenNumber(result.summary.totalTokens) }}</strong>
          <small>缓存 {{ tokenNumber(result.summary.cachedTokens) }}</small>
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
          <small>失败 {{ number(result.summary.failedCalls) }} 次</small>
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
            <div><dt>输入</dt><dd>{{ tokenNumber(result.summary.inputTokens) }}</dd></div>
            <div><dt>输出</dt><dd>{{ tokenNumber(result.summary.outputTokens) }}</dd></div>
            <div><dt>推理</dt><dd>{{ tokenNumber(result.summary.reasoningTokens) }}</dd></div>
            <div><dt>缓存</dt><dd>{{ tokenNumber(result.summary.cachedTokens) }}</dd></div>
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
                <td>{{ model.successRate.toFixed(1) }}%</td>
                <td>{{ tokenNumber(model.totalTokens) }}</td>
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
