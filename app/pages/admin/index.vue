<script setup lang="ts">
import {
  IconActivity,
  IconArrowUpRight,
  IconBraces,
  IconCoin,
  IconDownload,
  IconKey,
  IconRefresh,
  IconRoute,
  IconTimeline,
  IconUsers,
  IconUsersGroup
} from '@tabler/icons-vue'
import type { ChannelView, HubKeyView, HubOverview } from '#shared/types/hub'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '运行总览 | Zephyr Hub' })

const range = ref('24h')
const keyId = ref('')
const model = ref('')
const channelId = ref('')
const endpoint = ref('')
const status = ref('')
const customFrom = ref('')
const customTo = ref('')
const refreshing = ref(false)
const ranges = [
  { value: 'today', label: '今日' }, { value: '24h', label: '24 小时' },
  { value: 'week', label: '本周' }, { value: 'month', label: '本月' },
  { value: 'year', label: '本年' }, { value: 'all', label: '全部' }, { value: 'custom', label: '自定义' }
]
const overviewQuery = computed(() => ({ range: range.value, keyId: keyId.value || undefined, model: model.value || undefined, channelId: channelId.value || undefined, endpoint: endpoint.value || undefined, status: status.value || undefined, from: range.value === 'custom' && customFrom.value ? new Date(customFrom.value).toISOString() : undefined, to: range.value === 'custom' && customTo.value ? new Date(customTo.value).toISOString() : undefined }))
const { data, error, refresh } = await useFetch<HubOverview>('/api/admin/overview', { query: overviewQuery })
const { data: keyData } = await useFetch<{ keys: HubKeyView[] }>('/api/admin/keys')
const { data: channelData } = await useFetch<{ channels: ChannelView[] }>('/api/admin/channels')
const { data: modelData } = await useFetch<{ models: Array<{ publicModel: string }> }>('/api/admin/models')
const { data: alertData } = await useFetch<{ active: Array<{ id: string; title: string; message: string; severity: 'warning' | 'critical' }> }>('/api/admin/alerts')
const endpointOptions = ['/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/images/generations', '/v1/images/edits']

function compact(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
}
function money(value: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)
}
function percent(value: number | null) { return value === null ? '—' : `${value.toFixed(1)}%` }
function latency(value: number | null) { return value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms` }
function dateLabel(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit' }).format(value)
}
function exportUsage(format: 'csv' | 'json') {
  const values = { ...overviewQuery.value, range: undefined, from: data.value ? new Date(data.value.range.from).toISOString() : undefined, to: data.value ? new Date(data.value.range.to).toISOString() : undefined }
  const query = new URLSearchParams(Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
  query.set('format', format)
  window.location.assign(`/api/admin/exports/usage?${query}`)
}
const maxTimeline = computed(() => Math.max(1, ...(data.value?.timeline.map(item => item.requests) || [1])))

async function reload() {
  refreshing.value = true
  try { await refresh() } finally { refreshing.value = false }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header">
      <div><span class="admin-kicker">LIVE OPERATIONS</span><h1>运行总览</h1><p>渠道健康、请求趋势与成本状态。</p></div>
      <div class="admin-header-actions">
        <AppSelect v-model="keyId" class="admin-header-select"><option value="">全部 Hub Keys</option><option v-for="item in keyData?.keys || []" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect>
        <div class="admin-page-tabs admin-page-tabs--embedded" role="tablist" aria-label="统计时间范围"><button v-for="item in ranges" :key="item.value" type="button" role="tab" :aria-selected="range === item.value" :class="{ active: range === item.value }" @click="range = item.value">{{ item.label }}</button></div>
        <button class="button button--quiet button--small" title="导出 CSV" @click="exportUsage('csv')"><IconDownload :size="15" /> CSV</button><button class="button button--quiet button--small" title="导出 JSON" @click="exportUsage('json')"><IconDownload :size="15" /> JSON</button><button class="icon-button" title="刷新数据" :disabled="refreshing" @click="reload"><IconRefresh :class="{ 'is-spinning': refreshing }" :size="18" /></button>
      </div>
    </header>
    <section class="analytics-filters" aria-label="统计过滤器">
      <AppSelect v-model="model"><option value="">全部模型</option><option v-for="item in modelData?.models || []" :key="item.publicModel" :value="item.publicModel">{{ item.publicModel }}</option></AppSelect>
      <AppSelect v-model="channelId"><option value="">全部渠道</option><option v-for="item in channelData?.channels || []" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect>
      <AppSelect v-model="endpoint"><option value="">全部端点</option><option v-for="item in endpointOptions" :key="item" :value="item">{{ item.replace('/v1/', '') }}</option></AppSelect>
      <AppSelect v-model="status"><option value="">全部状态</option><option value="success">成功</option><option value="error">错误</option><option value="stream_aborted">流中断</option><option value="pending">进行中</option></AppSelect>
      <button v-if="model || channelId || endpoint || status" class="button button--quiet button--small" @click="model = ''; channelId = ''; endpoint = ''; status = ''">清除过滤</button>
    </section>
    <section v-if="range === 'custom'" class="custom-range"><label><span>开始时间</span><input v-model="customFrom" type="datetime-local"></label><label><span>结束时间</span><input v-model="customTo" type="datetime-local"></label><button class="button button--secondary button--small" :disabled="!customFrom || !customTo" @click="reload">应用范围</button></section>

    <InlineNotice v-if="error" tone="error" title="无法读取统计" :message="error.message" />

    <template v-if="data">
      <section class="admin-metrics">
        <article><span><IconActivity :size="17" /> 请求量</span><strong>{{ compact(data.totals.requests) }}</strong><small>{{ percent(data.totals.successRate) }} 成功</small></article>
        <article><span><IconBraces :size="17" /> Token</span><strong>{{ formatTokenCount(data.totals.totalTokens) }}</strong><small>输入与输出总计</small></article>
        <article><span><IconCoin :size="17" /> Hub 成本</span><strong>{{ money(data.totals.cost) }}</strong><small>按当前价格表结算</small></article>
        <article><span><IconTimeline :size="17" /> 平均延迟</span><strong>{{ latency(data.totals.averageLatencyMs) }}</strong><small>总 P95 {{ latency(data.totals.p95LatencyMs) }} · 首块 P95 {{ latency(data.totals.p95FirstByteMs) }}</small><small>SSE 中断 {{ percent(data.totals.streamAbortRate) }} · {{ compact(data.totals.failovers) }} 次切换</small></article>
      </section>

      <section class="admin-dashboard-grid">
        <article v-if="alertData?.active.length" class="admin-panel admin-panel--wide"><header><div><span>ATTENTION</span><h2>需要处理</h2></div><small>{{ alertData.active.length }} 项</small></header><div class="alert-list"><div v-for="alert in alertData.active" :key="alert.id" :data-severity="alert.severity"><strong>{{ alert.title }}</strong><p>{{ alert.message }}</p></div></div></article>
        <article class="admin-panel admin-panel--trend">
          <header><div><span>REQUEST VOLUME</span><h2>请求趋势</h2></div><small>{{ dateLabel(data.range.from) }} — {{ dateLabel(data.range.to) }}</small></header>
          <div v-if="data.timeline.length" class="hub-chart">
            <div v-for="point in data.timeline" :key="point.timestamp" class="hub-chart__point" :title="`${dateLabel(point.timestamp)} · ${point.requests} 次请求`">
              <span>{{ compact(point.requests) }}</span><i><b :style="{ height: `${Math.max(3, point.requests / maxTimeline * 100)}%` }" /></i><small>{{ dateLabel(point.timestamp) }}</small>
            </div>
          </div>
          <div v-else class="admin-empty">这个时间范围内还没有请求</div>
        </article>

        <article class="admin-panel admin-panel--pulse">
          <header><div><span>CAPACITY</span><h2>当前容量</h2></div><IconArrowUpRight :size="19" /></header>
          <dl class="capacity-list">
            <div><dt><IconKey :size="17" /> 已启用 Key</dt><dd>{{ data.activeKeys }}</dd></div>
            <div><dt><IconUsers :size="17" /> 活跃用户</dt><dd>{{ data.activeUsers }}</dd></div>
            <div><dt><IconUsersGroup :size="17" /> 活跃分组</dt><dd>{{ data.activeGroups }}</dd></div>
            <div><dt><IconRoute :size="17" /> 可用渠道</dt><dd>{{ data.healthyChannels }}</dd></div>
          </dl>
          <NuxtLink to="/admin/channels" class="admin-text-link">检查渠道路由 <IconArrowUpRight :size="15" /></NuxtLink>
        </article>

        <article class="admin-panel">
          <header><div><span>MODELS</span><h2>模型分布</h2></div><small>按请求量</small></header>
          <div v-if="data.models.length" class="rank-list">
            <div v-for="(model, index) in data.models.slice(0, 8)" :key="model.model"><span>{{ index + 1 }}</span><code>{{ model.model }}</code><b>{{ compact(model.requests) }}</b><small>{{ money(model.cost) }}</small></div>
          </div><div v-else class="admin-empty">暂无模型数据</div>
        </article>

        <article class="admin-panel">
          <header><div><span>CHANNELS</span><h2>渠道流量</h2></div><small>请求 / 错误</small></header>
          <div v-if="data.channels.length" class="rank-list">
            <div v-for="(channel, index) in data.channels.slice(0, 8)" :key="channel.id"><span>{{ index + 1 }}</span><code>{{ channel.name }}</code><b>{{ compact(channel.requests) }}</b><small>{{ channel.failures }} 错误</small></div>
          </div><div v-else class="admin-empty">暂无渠道数据</div>
        </article>
        <article class="admin-panel admin-panel--wide">
          <header><div><span>ENDPOINTS</span><h2>端点分布</h2></div><small>请求 / 错误 / 成本</small></header>
          <div v-if="data.endpoints.length" class="endpoint-rank">
            <div v-for="item in data.endpoints" :key="item.endpoint"><code>{{ item.endpoint }}</code><strong>{{ compact(item.requests) }}</strong><span>{{ item.failures }} 错误</span><small>{{ money(item.cost) }}</small></div>
          </div><div v-else class="admin-empty">暂无端点数据</div>
        </article>
        <article class="admin-panel admin-panel--wide"><header><div><span>USERS</span><h2>用户用量排行</h2></div><small>请求 / Token / 成本</small></header><div v-if="data.users.length" class="endpoint-rank"><div v-for="item in data.users" :key="item.id"><code>{{ item.name }}</code><strong>{{ compact(item.requests) }}</strong><span>{{ formatTokenCount(item.tokens) }} Token</span><small>{{ money(item.cost) }}</small></div></div><div v-else class="admin-empty">暂无用户数据</div></article>
        <article class="admin-panel admin-panel--wide"><header><div><span>GROUPS</span><h2>分组用量排行</h2></div><small>请求 / Token / 成本</small></header><div v-if="data.groups.length" class="endpoint-rank"><div v-for="item in data.groups" :key="item.id"><code>{{ item.name }}</code><strong>{{ compact(item.requests) }}</strong><span>{{ formatTokenCount(item.tokens) }} Token</span><small>{{ money(item.cost) }}</small></div></div><div v-else class="admin-empty">暂无分组数据</div></article>
        <article class="admin-panel admin-panel--wide">
          <header><div><span>HUB KEYS</span><h2>Key 流量</h2></div><small>请求 / Token / 成本</small></header>
          <div v-if="data.keys.length" class="endpoint-rank"><div v-for="item in data.keys" :key="item.id"><code>{{ item.name }}</code><strong>{{ compact(item.requests) }}</strong><span>{{ formatTokenCount(item.tokens) }} Token</span><small>{{ money(item.cost) }}</small></div></div><div v-else class="admin-empty">暂无 Key 数据</div>
        </article>
        <article class="admin-panel admin-panel--wide">
          <header><div><span>REQUEST STATUS</span><h2>状态分布</h2></div><small>请求 / 成本</small></header>
          <div v-if="data.statuses.length" class="status-rank"><div v-for="item in data.statuses" :key="item.status"><span class="status-dot" :data-status="item.status"><i />{{ item.status }}</span><strong>{{ compact(item.requests) }}</strong><small>{{ money(item.cost) }}</small></div></div><div v-else class="admin-empty">暂无状态数据</div>
        </article>
      </section>
      <AdminUpstreamCapacity embedded />
    </template>
  </div>
</template>
