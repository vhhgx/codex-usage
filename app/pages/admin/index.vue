<script setup lang="ts">
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowUpRight,
  IconBraces,
  IconChevronDown,
  IconCoin,
  IconDownload,
  IconFilter,
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
const trendMode = ref<'requests' | 'tokens' | 'cost'>('requests')
const rankingMode = ref<'users' | 'groups' | 'keys'>('users')
const filtersCollapsed = ref(false)
const customFrom = ref('')
const customTo = ref('')
const refreshing = ref(false)
const ranges = [
  { value: 'today', label: '今日' }, { value: '24h', label: '24 小时' },
  { value: 'week', label: '本周' }, { value: 'month', label: '本月' },
  { value: 'year', label: '本年' }, { value: 'all', label: '全部' }, { value: 'custom', label: '自定义' }
]
const overviewQuery = computed(() => ({ range: range.value, keyId: keyId.value || undefined, model: model.value || undefined, channelId: channelId.value || undefined, endpoint: endpoint.value || undefined, status: status.value || undefined, from: range.value === 'custom' && customFrom.value ? new Date(customFrom.value).toISOString() : undefined, to: range.value === 'custom' && customTo.value ? new Date(customTo.value).toISOString() : undefined }))
const { data, error, refresh, status: overviewStatus } = await useFetch<HubOverview>('/api/admin/overview', { query: overviewQuery })
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
const activeFilterCount = computed(() => [model.value, channelId.value, endpoint.value, status.value].filter(Boolean).length)
const rankingItems = computed(() => data.value?.[rankingMode.value] || [])

function clearFilters() {
  model.value = ''
  channelId.value = ''
  endpoint.value = ''
  status.value = ''
}

function updateSpotlight(event: PointerEvent) {
  if (!window.matchMedia('(min-width: 961px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches
    || window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return
  const element = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  element.style.setProperty('--spot-x', `${event.clientX - rect.left}px`)
  element.style.setProperty('--spot-y', `${event.clientY - rect.top}px`)
}

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
        <button class="button button--quiet button--small" title="导出 CSV" @click="exportUsage('csv')"><IconDownload :size="15" /> CSV</button><button class="button button--quiet button--small" title="导出 JSON" @click="exportUsage('json')"><IconDownload :size="15" /> JSON</button><button class="icon-button" title="刷新数据" aria-label="刷新数据" :disabled="refreshing" @click="reload"><IconRefresh :class="{ 'is-spinning': refreshing }" :size="18" /></button>
      </div>
    </header>
    <section class="overview-filter-panel" :class="{ 'is-collapsed': filtersCollapsed }" aria-label="统计过滤器">
      <header>
        <div><IconFilter :size="15" /><strong>统计过滤器</strong><span v-if="activeFilterCount" class="filter-count tabular-nums">{{ activeFilterCount }}</span></div>
        <button class="icon-button overview-filter-toggle" type="button" :title="filtersCollapsed ? '展开过滤器' : '收起过滤器'" :aria-label="filtersCollapsed ? '展开过滤器' : '收起过滤器'" :aria-expanded="!filtersCollapsed" @click="filtersCollapsed = !filtersCollapsed"><IconChevronDown :size="16" :class="{ rotated: filtersCollapsed }" /></button>
      </header>
      <div v-if="!filtersCollapsed" class="analytics-filters">
        <AppSelect v-model="model"><option value="">全部模型</option><option v-for="item in modelData?.models || []" :key="item.publicModel" :value="item.publicModel">{{ item.publicModel }}</option></AppSelect>
        <AppSelect v-model="channelId"><option value="">全部渠道</option><option v-for="item in channelData?.channels || []" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect>
        <AppSelect v-model="endpoint"><option value="">全部端点</option><option v-for="item in endpointOptions" :key="item" :value="item">{{ item.replace('/v1/', '') }}</option></AppSelect>
        <AppSelect v-model="status"><option value="">全部状态</option><option value="success">成功</option><option value="error">错误</option><option value="stream_aborted">流中断</option><option value="pending">进行中</option></AppSelect>
        <button class="button button--quiet button--small" :disabled="!activeFilterCount" @click="clearFilters">清除过滤</button>
      </div>
    </section>
    <section v-if="range === 'custom'" class="custom-range"><label><span>开始时间</span><input v-model="customFrom" type="datetime-local"></label><label><span>结束时间</span><input v-model="customTo" type="datetime-local"></label><button class="button button--secondary button--small" :disabled="!customFrom || !customTo" @click="reload">应用范围</button></section>

    <InlineNotice v-if="error" tone="error" title="无法读取统计" :message="error.message" />

    <div v-if="overviewStatus === 'pending' && !data" class="overview-loading" aria-label="正在读取运行总览"><span v-for="index in 8" :key="index" /></div>

    <template v-if="data">
      <section class="admin-metrics">
        <article class="spotlight-panel" @pointermove="updateSpotlight"><header><span>请求量</span><IconActivity :size="16" /></header><strong>{{ compact(data.totals.requests) }}</strong><small>{{ percent(data.totals.successRate) }} 成功，{{ compact(data.totals.failures) }} 次失败</small></article>
        <article class="spotlight-panel" @pointermove="updateSpotlight"><header><span>Token</span><IconBraces :size="16" /></header><strong>{{ formatTokenCount(data.totals.totalTokens) }}</strong><small>输入与输出总计</small></article>
        <article class="spotlight-panel" @pointermove="updateSpotlight"><header><span>Hub 成本</span><IconCoin :size="16" /></header><strong>{{ money(data.totals.cost) }}</strong><small>按当前价格表结算</small></article>
        <article class="spotlight-panel" @pointermove="updateSpotlight"><header><span>平均延迟</span><IconTimeline :size="16" /></header><strong>{{ latency(data.totals.averageLatencyMs) }}</strong><small>总 P95 {{ latency(data.totals.p95LatencyMs) }}，首块 P95 {{ latency(data.totals.p95FirstByteMs) }}</small></article>
      </section>

      <section v-if="alertData?.active.length" class="overview-alert" aria-label="活动告警"><IconAlertTriangle :size="18" /><div><strong>{{ alertData.active.length }} 项需要处理</strong><span>{{ alertData.active[0]?.title }}<template v-if="alertData.active[0]?.message">：{{ alertData.active[0].message }}</template></span></div><NuxtLink to="/admin/settings">查看告警 <IconArrowUpRight :size="14" /></NuxtLink></section>

      <section class="overview-primary-grid">
        <article class="admin-panel overview-trend-panel spotlight-panel" @pointermove="updateSpotlight">
          <header><div><span>REQUEST TREND</span><h2>请求趋势</h2></div><div class="trend-header-actions"><small>{{ dateLabel(data.range.from) }} - {{ dateLabel(data.range.to) }}</small><div class="admin-page-tabs admin-page-tabs--embedded" role="tablist" aria-label="趋势指标"><button type="button" role="tab" :aria-selected="trendMode === 'requests'" :class="{ active: trendMode === 'requests' }" @click="trendMode = 'requests'">请求量</button><button type="button" role="tab" :aria-selected="trendMode === 'tokens'" :class="{ active: trendMode === 'tokens' }" @click="trendMode = 'tokens'">Token</button><button type="button" role="tab" :aria-selected="trendMode === 'cost'" :class="{ active: trendMode === 'cost' }" @click="trendMode = 'cost'">成本</button></div></div></header>
          <AdminHubTrendChart v-if="data.timeline.length" :points="data.timeline" :mode="trendMode" />
          <div v-else class="admin-empty">这个时间范围内还没有请求</div>
        </article>

        <article class="admin-panel overview-capacity-panel spotlight-panel" @pointermove="updateSpotlight">
          <header><div><span>CAPACITY</span><h2>当前容量</h2></div><IconArrowUpRight :size="19" /></header>
          <dl class="capacity-list">
            <div><dt><IconKey :size="17" /> 已启用 Key</dt><dd>{{ data.activeKeys }}</dd></div>
            <div><dt><IconUsers :size="17" /> 活跃用户</dt><dd>{{ data.activeUsers }}</dd></div>
            <div><dt><IconUsersGroup :size="17" /> 活跃分组</dt><dd>{{ data.activeGroups }}</dd></div>
            <div><dt><IconRoute :size="17" /> 可用渠道</dt><dd>{{ data.healthyChannels }}</dd></div>
          </dl>
          <NuxtLink to="/admin/channels" class="admin-text-link">检查渠道路由 <IconArrowUpRight :size="15" /></NuxtLink>
        </article>
      </section>

      <section class="overview-rank-grid">
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
        <article class="admin-panel overview-ranking-panel">
          <header><div><span>USAGE RANKING</span><h2>用量排行</h2></div><div class="admin-page-tabs admin-page-tabs--embedded" role="tablist" aria-label="排行维度"><button type="button" role="tab" :aria-selected="rankingMode === 'users'" :class="{ active: rankingMode === 'users' }" @click="rankingMode = 'users'">用户</button><button type="button" role="tab" :aria-selected="rankingMode === 'groups'" :class="{ active: rankingMode === 'groups' }" @click="rankingMode = 'groups'">分组</button><button type="button" role="tab" :aria-selected="rankingMode === 'keys'" :class="{ active: rankingMode === 'keys' }" @click="rankingMode = 'keys'">Hub Keys</button></div></header>
          <div v-if="rankingItems.length" class="usage-rank"><div v-for="item in rankingItems.slice(0, 8)" :key="item.id"><code>{{ item.name }}</code><strong>{{ compact(item.requests) }}</strong><span>{{ formatTokenCount(item.tokens) }} Token</span><small>{{ money(item.cost) }}</small></div></div><div v-else class="admin-empty">暂无排行数据</div>
        </article>
      </section>
      <AdminUpstreamCapacity embedded />
    </template>
  </div>
</template>

<style scoped>
.overview-filter-panel { margin-bottom: var(--hub-grid-gap); border: 1px solid var(--hub-line); border-radius: var(--hub-radius-panel); background: var(--hub-glass); box-shadow: var(--hub-panel-highlight); }
.overview-filter-panel > header { min-height: 46px; padding: 0 var(--hub-space-3); display: flex; align-items: center; justify-content: space-between; gap: var(--hub-space-3); }
.overview-filter-panel > header > div { display: flex; align-items: center; gap: var(--hub-space-2); color: var(--hub-text-muted); }
.overview-filter-panel > header strong { font-size: var(--hub-text-xs); }
.filter-count { min-width: 20px; height: 20px; border: 1px solid var(--hub-accent-line); border-radius: var(--hub-radius-xs); display: grid; place-items: center; color: var(--hub-accent-text); background: var(--hub-accent-soft); font-family: var(--hub-font-mono); font-size: var(--hub-text-micro); }
.overview-filter-toggle { width: 28px; height: 28px; }
.overview-filter-toggle svg { transition: transform var(--hub-duration-base) ease; }
.overview-filter-toggle svg.rotated { transform: rotate(-90deg); }
.analytics-filters { min-height: 0; margin: 0; padding: var(--hub-space-3); border-top: 1px solid var(--hub-line-row); border-bottom: 0; display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)) auto; gap: var(--hub-space-2); }
.analytics-filters .app-select { min-width: 0; }
.overview-loading { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--hub-grid-gap); }
.overview-loading span { height: 136px; border-radius: var(--hub-radius-panel); background: var(--hub-skeleton); }
.admin-metrics { margin-bottom: var(--hub-grid-gap); border: 0; border-radius: 0; overflow: visible; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--hub-grid-gap); background: transparent; }
.admin-metrics article { min-height: 146px; padding: var(--hub-panel-padding); border: 1px solid var(--hub-line); border-radius: var(--hub-radius-panel); display: grid; align-content: start; background: var(--hub-glass); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); }
.admin-metrics article:last-child { border-right: 1px solid var(--hub-line); }
.admin-metrics article > header { display: flex; align-items: center; justify-content: space-between; color: var(--hub-text-muted); }
.admin-metrics article > header span { font-size: var(--hub-text-xs); }
.admin-metrics article > header svg { width: 30px; height: 30px; padding: 7px; border: 1px solid var(--hub-line); border-radius: var(--hub-radius-md); color: var(--hub-text-faint); }
.admin-metrics strong { margin-top: var(--hub-space-5); color: var(--hub-stat-value); font-family: var(--hub-font-mono); font-size: var(--hub-text-stat); font-weight: var(--hub-weight-medium); line-height: 1; }
.admin-metrics small { margin-top: var(--hub-space-3); color: var(--hub-text-faint); font-size: var(--hub-text-micro); }
.overview-alert { min-height: 58px; margin-bottom: var(--hub-grid-gap); padding: var(--hub-space-2) var(--hub-space-3); border: 1px solid var(--hub-warning-line); border-radius: var(--hub-radius-panel); display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: var(--hub-space-3); color: var(--hub-warning); background: var(--hub-warning-soft); }
.overview-alert > svg { width: 32px; height: 32px; padding: 7px; border: 1px solid var(--hub-warning-line); border-radius: var(--hub-radius-md); }
.overview-alert > div { min-width: 0; display: grid; gap: 2px; }
.overview-alert strong { color: var(--hub-text); font-size: var(--hub-text-xs); }
.overview-alert span { overflow: hidden; color: var(--hub-text-muted); font-size: var(--hub-text-micro); text-overflow: ellipsis; white-space: nowrap; }
.overview-alert a { display: inline-flex; align-items: center; gap: var(--hub-space-1); color: var(--hub-warning); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-semibold); }
.overview-primary-grid { margin-bottom: var(--hub-grid-gap); display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, .82fr); gap: var(--hub-grid-gap); }
.overview-trend-panel { min-height: 354px; }
.overview-capacity-panel { min-height: 354px; }
.trend-header-actions { display: flex; align-items: center; gap: var(--hub-space-3); }
.capacity-list { padding: 4px var(--hub-space-4) 0; }
.capacity-list div { min-height: 56px; border-bottom: 1px solid var(--hub-line-row); }
.capacity-list dt { color: var(--hub-text-muted); font-size: var(--hub-text-xs); }
.capacity-list dd { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: var(--hub-text-md); }
.overview-capacity-panel .admin-text-link { margin: var(--hub-space-3) var(--hub-space-4); color: var(--hub-accent-text); }
.overview-rank-grid { margin-bottom: var(--hub-space-6); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--hub-grid-gap); }
.rank-list { padding: 4px var(--hub-space-4) var(--hub-space-3); }
.rank-list > div { min-height: 45px; border-color: var(--hub-line-row); }
.rank-list span, .rank-list small { color: var(--hub-text-faint); }
.rank-list code, .rank-list b { color: var(--hub-text); }
.usage-rank { padding: 4px var(--hub-space-4) var(--hub-space-3); }
.usage-rank > div { min-height: 45px; border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: var(--hub-space-2); }
.usage-rank > div:last-child { border-bottom: 0; }
.usage-rank code { min-width: 0; overflow: hidden; color: var(--hub-text); font-size: var(--hub-text-xs); text-overflow: ellipsis; white-space: nowrap; }
.usage-rank strong { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: var(--hub-text-xs); }
.usage-rank span, .usage-rank small { color: var(--hub-text-faint); font-size: var(--hub-text-micro); white-space: nowrap; }
@media (max-width: 1180px) { .overview-primary-grid { grid-template-columns: 1fr; } .overview-capacity-panel { min-height: auto; } .overview-rank-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .overview-ranking-panel { grid-column: 1 / -1; } }
@media (max-width: 850px) { .analytics-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } .analytics-filters .button { grid-column: 1 / -1; } .admin-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .trend-header-actions { align-items: flex-end; flex-direction: column; gap: var(--hub-space-2); } .overview-rank-grid { grid-template-columns: 1fr; } .overview-ranking-panel { grid-column: auto; } }
@media (max-width: 480px) { .analytics-filters { grid-template-columns: 1fr; } .admin-metrics { grid-template-columns: 1fr; } .overview-alert { grid-template-columns: 32px minmax(0, 1fr); } .overview-alert a { grid-column: 2; } }
</style>
