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
function percent(value: number | null) { return value === null ? '--' : `${value.toFixed(1)}%` }
function latency(value: number | null) { return value === null ? '--' : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms` }
function perRequest(value: number, requests: number) { return requests > 0 ? value / requests : 0 }
function exportUsage(format: 'csv' | 'json') {
  const values = { ...overviewQuery.value, range: undefined, from: data.value ? new Date(data.value.range.from).toISOString() : undefined, to: data.value ? new Date(data.value.range.to).toISOString() : undefined }
  const query = new URLSearchParams(Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
  query.set('format', format)
  window.location.assign(`/api/admin/exports/usage?${query}`)
}
const activeFilterCount = computed(() => [model.value, channelId.value, endpoint.value, status.value].filter(Boolean).length)
const rankingItems = computed(() => data.value?.[rankingMode.value] || [])
const trendSubtitle = computed(() => trendMode.value === 'requests'
  ? '按时间段统计的请求量'
  : trendMode.value === 'tokens'
    ? '按时间段统计的 Token 吞吐'
    : '按时间段统计的 Hub 成本')
const serviceStatus = computed(() => {
  if (error.value) return { tone: 'error', label: '运行状态暂不可用' }
  if (overviewStatus.value === 'pending' && !data.value) return { tone: 'pending', label: '正在检查核心服务' }
  const activeAlerts = alertData.value?.active.length || 0
  if (activeAlerts) return { tone: 'warning', label: `${activeAlerts} 项运行告警待处理` }
  return { tone: 'healthy', label: '所有核心服务在线' }
})

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
    <header class="admin-page__header overview-page-header">
      <div><span class="overview-live-status" :data-tone="serviceStatus.tone"><i aria-hidden="true" />{{ serviceStatus.label }}</span><h1>运行总览</h1><p>渠道健康、请求趋势与成本状态。</p></div>
      <div class="admin-header-actions overview-page-actions">
        <AppSelect v-model="keyId" class="admin-header-select overview-key-select"><option value="">全部 Hub Keys</option><option v-for="item in keyData?.keys || []" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect>
        <div class="admin-page-tabs admin-page-tabs--embedded overview-period-scroller" role="tablist" aria-label="统计时间范围"><button v-for="item in ranges" :key="item.value" type="button" role="tab" :aria-selected="range === item.value" :class="{ active: range === item.value }" @click="range = item.value">{{ item.label }}</button></div>
        <button class="button button--quiet button--small overview-export-button overview-export-button--csv" title="导出 CSV" @click="exportUsage('csv')"><IconDownload :size="14" /> CSV</button><button class="button button--quiet button--small overview-export-button overview-export-button--json" title="导出 JSON" @click="exportUsage('json')"><IconDownload :size="14" /> JSON</button><button class="icon-button overview-refresh-button" title="刷新数据" aria-label="刷新数据" :disabled="refreshing" @click="reload"><IconRefresh :class="{ 'is-spinning': refreshing }" :size="16" /></button>
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
      <section class="stats-grid" aria-label="关键指标">
        <article class="glass-panel stat-card spotlight-panel" @pointermove="updateSpotlight">
          <div class="stat-card__head">
            <div><h2>总请求量</h2><span class="stat-trend"><IconActivity :size="12" />{{ percent(data.totals.successRate) }} 成功率</span></div>
            <span class="stat-icon"><IconActivity :size="14" /></span>
          </div>
          <div class="stat-value">{{ compact(data.totals.requests) }}</div>
          <p>{{ compact(data.totals.successes) }} 次成功，{{ compact(data.totals.failures) }} 次失败</p>
        </article>
        <article class="glass-panel stat-card spotlight-panel" @pointermove="updateSpotlight">
          <div class="stat-card__head">
            <div><h2>Token</h2><span class="stat-trend"><IconBraces :size="12" />{{ formatTokenCount(perRequest(data.totals.totalTokens, data.totals.requests)) }} / 请求</span></div>
            <span class="stat-icon"><IconBraces :size="14" /></span>
          </div>
          <div class="stat-value">{{ formatTokenCount(data.totals.totalTokens) }}</div>
          <p>输入与输出总计</p>
        </article>
        <article class="glass-panel stat-card spotlight-panel" @pointermove="updateSpotlight">
          <div class="stat-card__head">
            <div><h2>Hub 成本</h2><span class="stat-trend stat-trend--warning"><IconCoin :size="12" />{{ money(perRequest(data.totals.cost, data.totals.requests)) }} / 请求</span></div>
            <span class="stat-icon"><IconCoin :size="14" /></span>
          </div>
          <div class="stat-value">{{ money(data.totals.cost) }}</div>
          <p>按当前价格表结算</p>
        </article>
        <article class="glass-panel stat-card spotlight-panel" @pointermove="updateSpotlight">
          <div class="stat-card__head">
            <div><h2>平均延迟</h2><span class="stat-trend"><IconTimeline :size="12" />P95 {{ latency(data.totals.p95LatencyMs) }}</span></div>
            <span class="stat-icon"><IconTimeline :size="14" /></span>
          </div>
          <div class="stat-value">{{ latency(data.totals.averageLatencyMs) }}</div>
          <p>总 P95 {{ latency(data.totals.p95LatencyMs) }}，首块 P95 {{ latency(data.totals.p95FirstByteMs) }}</p>
        </article>
      </section>

      <section v-if="alertData?.active.length" class="glass-panel alert-panel" aria-label="活动告警">
        <span class="alert-icon"><IconAlertTriangle :size="16" /></span>
        <div><strong>{{ alertData.active.length }} 项需要处理</strong><span>{{ alertData.active[0]?.title }}<template v-if="alertData.active[0]?.message">：{{ alertData.active[0].message }}</template></span></div>
        <NuxtLink to="/admin/settings" class="button button--quiet button--small">查看告警 <IconArrowUpRight :size="14" /></NuxtLink>
      </section>

      <section class="dashboard-grid">
        <article class="glass-panel chart-shell spotlight-panel" @pointermove="updateSpotlight">
          <header class="panel-heading chart-panel__heading">
            <div><h2>请求趋势</h2><p>{{ trendSubtitle }}</p></div>
            <div class="admin-page-tabs admin-page-tabs--embedded chart-segmented" role="tablist" aria-label="趋势指标"><button type="button" role="tab" :aria-selected="trendMode === 'requests'" :class="{ active: trendMode === 'requests' }" @click="trendMode = 'requests'">请求量</button><button type="button" role="tab" :aria-selected="trendMode === 'tokens'" :class="{ active: trendMode === 'tokens' }" @click="trendMode = 'tokens'">Token</button><button type="button" role="tab" :aria-selected="trendMode === 'cost'" :class="{ active: trendMode === 'cost' }" @click="trendMode = 'cost'">成本</button></div>
          </header>
          <AdminHubTrendChart v-if="data.timeline.length" :points="data.timeline" :mode="trendMode" :from="data.range.from" :to="data.range.to" />
          <div v-else class="admin-empty">这个时间范围内还没有请求</div>
        </article>

        <aside class="glass-panel health-panel spotlight-panel" aria-labelledby="capacity-title" @pointermove="updateSpotlight">
          <header class="panel-heading">
            <div><h2 id="capacity-title">当前容量</h2><p>管理资源实时状态</p></div>
            <IconArrowUpRight :size="16" class="capacity-heading-icon" />
          </header>
          <div class="health-panel__body">
            <div class="health-row"><div class="health-row__label"><span class="health-icon health-icon--accent"><IconKey :size="14" /></span><div><strong>已启用 Key</strong><span>当前启用</span></div></div><b>{{ data.activeKeys }}</b></div>
            <div class="health-row"><div class="health-row__label"><span class="health-icon"><IconUsers :size="14" /></span><div><strong>活跃用户</strong><span>当前周期</span></div></div><b>{{ data.activeUsers }}</b></div>
            <div class="health-row"><div class="health-row__label"><span class="health-icon"><IconUsersGroup :size="14" /></span><div><strong>活跃分组</strong><span>当前周期</span></div></div><b>{{ data.activeGroups }}</b></div>
            <div class="health-row"><div class="health-row__label"><span class="health-icon"><IconRoute :size="14" /></span><div><strong>可用渠道</strong><span>当前健康</span></div></div><b>{{ data.healthyChannels }}</b></div>
            <NuxtLink to="/admin/channels" class="health-panel__action"><span>检查渠道路由</span><IconArrowUpRight :size="14" /></NuxtLink>
          </div>
        </aside>
      </section>

      <section class="rank-grid">
        <article class="glass-panel rank-panel">
          <header class="panel-heading"><div><h2>模型分布</h2><p>按请求量</p></div><span class="panel-meta">{{ data.models.length }} MODELS</span></header>
          <div v-if="data.models.length" class="rank-list">
            <div v-for="(model, index) in data.models.slice(0, 4)" :key="model.model" class="rank-row"><span class="rank-index">{{ String(index + 1).padStart(2, '0') }}</span><code class="rank-name">{{ model.model }}</code><strong class="rank-value">{{ compact(model.requests) }}</strong><small class="rank-meta">{{ money(model.cost) }}</small></div>
          </div><div v-else class="admin-empty">暂无模型数据</div>
        </article>

        <article class="glass-panel rank-panel">
          <header class="panel-heading"><div><h2>渠道流量</h2><p>请求 / 错误</p></div><NuxtLink to="/admin/channels" class="panel-action">管理渠道</NuxtLink></header>
          <div v-if="data.channels.length" class="rank-list">
            <div v-for="(channel, index) in data.channels.slice(0, 4)" :key="channel.id" class="rank-row"><span class="rank-index">{{ String(index + 1).padStart(2, '0') }}</span><code class="rank-name">{{ channel.name }}</code><strong class="rank-value">{{ compact(channel.requests) }}</strong><small class="rank-meta" :class="{ 'rank-meta--danger': channel.failures > 0 }">{{ channel.failures }} 错误</small></div>
          </div><div v-else class="admin-empty">暂无渠道数据</div>
        </article>
        <article class="glass-panel ranking-panel">
          <header class="panel-heading"><div><h2>用量排行</h2><p>请求 / Token / 成本</p></div><div class="admin-page-tabs admin-page-tabs--embedded ranking-segmented" role="tablist" aria-label="排行维度"><button type="button" role="tab" :aria-selected="rankingMode === 'users'" :class="{ active: rankingMode === 'users' }" @click="rankingMode = 'users'">用户</button><button type="button" role="tab" :aria-selected="rankingMode === 'groups'" :class="{ active: rankingMode === 'groups' }" @click="rankingMode = 'groups'">分组</button><button type="button" role="tab" :aria-selected="rankingMode === 'keys'" :class="{ active: rankingMode === 'keys' }" @click="rankingMode = 'keys'">Hub Keys</button></div></header>
          <div v-if="rankingItems.length" class="distribution-body"><div v-for="item in rankingItems.slice(0, 4)" :key="item.id" class="distribution-row"><code>{{ item.name }}</code><strong>{{ compact(item.requests) }}</strong><span>{{ formatTokenCount(item.tokens) }} Token</span><small>{{ money(item.cost) }}</small></div></div><div v-else class="admin-empty">暂无排行数据</div>
        </article>
      </section>
      <AdminUpstreamCapacity embedded />
    </template>
  </div>
</template>

<style scoped>
.overview-filter-panel { margin-bottom: var(--hub-grid-gap); border: 1px solid var(--hub-line); border-radius: var(--hub-radius-panel); background: var(--hub-glass); box-shadow: var(--hub-panel-highlight); }
.overview-filter-panel > header { min-height: 44px; padding: 0 var(--hub-space-3); display: flex; align-items: center; justify-content: space-between; gap: var(--hub-space-3); }
.overview-filter-panel > header > div { display: flex; align-items: center; gap: var(--hub-space-2); color: var(--hub-text-muted); }
.overview-filter-panel > header strong { font-size: var(--hub-text-xs); }
.filter-count { min-width: 20px; height: 20px; border: 1px solid var(--hub-accent-line); border-radius: var(--hub-radius-xs); display: grid; place-items: center; color: var(--hub-accent-text); background: var(--hub-accent-soft); font-family: var(--hub-font-mono); font-size: var(--hub-text-micro); }
.overview-filter-toggle { width: 28px; height: 28px; }
.overview-filter-toggle svg { transition: transform var(--hub-duration-base) ease; }
.overview-filter-toggle svg.rotated { transform: rotate(-90deg); }
.analytics-filters { min-height: 0; margin: 0; padding: var(--hub-space-2) var(--hub-space-3); border-top: 1px solid var(--hub-line-row); border-bottom: 0; display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)) auto; gap: var(--hub-space-2); }
.analytics-filters .app-select { min-width: 0; }
.overview-loading { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--hub-grid-gap); }
.overview-loading span { height: 160px; border-radius: var(--hub-radius-panel); background: var(--hub-skeleton); }
.overview-page-header { min-height: 104px; }
.overview-page-header h1 { font-size: 2.2rem; }
.overview-page-actions { max-width: min(100%, 56rem); align-items: center; flex-wrap: wrap; gap: var(--hub-space-2); }
.overview-page-actions > .app-select { width: 9.5125rem; min-width: 9.5125rem; border-radius: var(--hub-radius-lg); background: var(--hub-input-bg); backdrop-filter: var(--hub-blur-control); }
.overview-page-actions :deep(.overview-key-select) { min-width: 9.5125rem; min-height: 2.25rem; padding: 0 2rem 0 .7rem !important; border-color: var(--hub-line); border-radius: var(--hub-radius-lg); color: var(--hub-text-muted); background: transparent; font-size: var(--hub-text-xs); }
.overview-page-actions :deep(.app-select__icon) { right: .7rem; }
.overview-period-scroller { width: 25.90625rem; max-width: 29rem; min-height: 0; border-radius: var(--hub-radius-panel); flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; backdrop-filter: var(--hub-blur-control); }
.overview-period-scroller::-webkit-scrollbar { display: none; }
.overview-period-scroller button { min-height: 2.05rem; padding: 0 .8rem; border: 1px solid transparent; border-radius: var(--hub-radius-sm); color: var(--hub-text-faint); font-size: .76rem; font-weight: var(--hub-weight-medium); }
.overview-period-scroller button.active,
.overview-period-scroller button[aria-selected='true'] { border-color: var(--hub-line); color: var(--hub-text); background: var(--hub-glass-strong); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); }
.overview-page-actions > .overview-export-button { min-height: 2.25rem; padding: 0 .72rem; gap: .4rem; border-color: var(--hub-line); border-radius: var(--hub-radius-lg); color: var(--hub-text-muted); background: var(--hub-input-bg); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-regular); backdrop-filter: var(--hub-blur-control); }
.overview-page-actions > .overview-export-button--csv { width: 4.3875rem; }
.overview-page-actions > .overview-export-button--json { width: 4.8875rem; }
.overview-page-actions > .overview-refresh-button { width: 2.25rem; height: 2.25rem; backdrop-filter: var(--hub-blur-control); }
.overview-live-status { margin-bottom: var(--hub-space-2); display: inline-flex; align-items: center; gap: var(--hub-space-2); color: var(--hub-text-muted); font-size: var(--hub-text-xs); }
.overview-live-status i { width: 7px; height: 7px; border-radius: var(--hub-radius-round); flex: 0 0 auto; background: var(--hub-success); box-shadow: 0 0 0 3px var(--hub-success-soft); }
.overview-live-status[data-tone='warning'] i { background: var(--hub-warning); box-shadow: 0 0 0 3px var(--hub-warning-soft); }
.overview-live-status[data-tone='error'] i { background: var(--hub-danger); box-shadow: 0 0 0 3px var(--hub-danger-soft); }
.overview-live-status[data-tone='pending'] i { background: var(--hub-text-faint); box-shadow: 0 0 0 3px var(--hub-skeleton-strong); }
.stats-grid { margin-bottom: var(--hub-grid-gap); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--hub-grid-gap); }
.stat-card { min-width: 0; min-height: 160px; padding: var(--hub-panel-padding); }
.stat-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--hub-space-3); }
.stat-card__head h2 { color: var(--hub-text-muted); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-medium); }
.stat-trend { margin-top: var(--hub-space-2); display: inline-flex; align-items: center; gap: 3px; color: var(--hub-success); font-family: var(--hub-font-mono); font-size: .74rem; }
.stat-trend--warning { color: var(--hub-warning); }
.stat-icon { width: var(--hub-icon-box-size); height: var(--hub-icon-box-size); border: 1px solid var(--hub-line); border-radius: var(--hub-radius-md); display: grid; place-items: center; flex: 0 0 auto; color: var(--hub-text-faint); background: var(--hub-glass-strong); }
.stat-value { margin-top: 1.05rem; color: var(--hub-stat-value); font-family: var(--hub-font-mono); font-size: clamp(1.8rem, 2.5vw, 2.5rem); font-weight: var(--hub-weight-medium); line-height: 1; }
.stat-card > p { margin-top: var(--hub-space-2); color: var(--hub-text-faint); font-size: var(--hub-text-xs); }
.alert-panel { min-height: 66px; margin-bottom: var(--hub-grid-gap); padding: var(--hub-space-3) .85rem; border-color: var(--hub-warning-line); display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--hub-space-3); background: linear-gradient(90deg, var(--hub-warning-soft), var(--hub-glass) 58%); }
.alert-icon { width: var(--hub-icon-box-size); height: var(--hub-icon-box-size); border: 1px solid var(--hub-warning-line); border-radius: var(--hub-radius-md); display: grid; place-items: center; color: var(--hub-warning); background: var(--hub-warning-soft); }
.alert-panel > div { min-width: 0; display: grid; gap: var(--hub-space-1); }
.alert-panel strong { color: var(--hub-text); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-medium); }
.alert-panel > div > span { overflow: hidden; color: var(--hub-text-muted); font-size: var(--hub-text-xs); text-overflow: ellipsis; white-space: nowrap; }
.dashboard-grid { margin-bottom: var(--hub-grid-gap); display: grid; grid-template-columns: minmax(0, 1fr) minmax(15rem, 16rem); gap: var(--hub-grid-gap); }
.chart-shell, .health-panel { min-width: 0; min-height: 449px; }
.panel-heading { min-height: 3.8rem; padding: 0 var(--hub-panel-padding); border-bottom: 1px solid var(--hub-line); display: flex; align-items: center; justify-content: space-between; gap: var(--hub-space-4); }
.panel-heading h2 { color: var(--hub-text); font-size: .84rem; font-weight: var(--hub-weight-semibold); }
.panel-heading p { margin-top: .22rem; color: var(--hub-text-faint); font-size: .7rem; }
.chart-segmented { flex: 0 0 auto; }
.chart-segmented button { min-height: 2.05rem; padding-inline: .8rem; font-size: .76rem; }
.health-panel__body { padding: .25rem var(--hub-panel-padding) var(--hub-panel-padding); }
.capacity-heading-icon { color: var(--hub-accent-bright); }
.health-row { min-height: 56px; padding: .72rem 0; border-top: 1px solid var(--hub-line); display: flex; align-items: center; justify-content: space-between; gap: var(--hub-space-4); }
.health-row:first-child { border-top: 0; }
.health-row__label { min-width: 0; display: flex; align-items: center; gap: var(--hub-space-3); }
.health-row__label > div { min-width: 0; display: grid; gap: var(--hub-space-1); }
.health-row__label strong { color: var(--hub-text); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-medium); }
.health-row__label span:not(.health-icon) { color: var(--hub-text-faint); font-size: .71875rem; }
.health-row > b { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .78125rem; font-weight: var(--hub-weight-medium); }
.health-icon { width: var(--hub-icon-box-size); height: var(--hub-icon-box-size); border: 1px solid var(--hub-line); border-radius: var(--hub-radius-md); display: grid; place-items: center; flex: 0 0 auto; color: var(--hub-text-faint); background: var(--hub-glass-strong); }
.health-icon--accent { border-color: var(--hub-accent-line); color: var(--hub-accent-bright); background: var(--hub-accent-soft); }
.health-panel__action { width: 100%; margin-top: var(--hub-space-1); padding-top: var(--hub-space-3); border-top: 1px solid var(--hub-line); display: flex; align-items: center; justify-content: space-between; color: var(--hub-accent-text); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-medium); }
.rank-grid { margin-bottom: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--hub-grid-gap); }
.rank-grid > article { min-height: 269px; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.rank-grid .admin-empty { align-self: center; }
.panel-meta { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: var(--hub-text-xs); }
.panel-action { color: var(--hub-accent-text); font-size: var(--hub-text-xs); }
.rank-list { padding: var(--hub-space-1) var(--hub-panel-padding) .65rem; }
.rank-row { min-height: 3rem; border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) auto auto; align-items: center; gap: .65rem; }
.rank-row:last-child { border-bottom: 0; }
.rank-index { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .72rem; }
.rank-name { min-width: 0; overflow: hidden; color: var(--hub-text); font-family: var(--hub-font-mono); font-size: var(--hub-text-xs); text-overflow: ellipsis; white-space: nowrap; }
.rank-value { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-medium); }
.rank-meta { min-width: 4.2rem; color: var(--hub-text-faint); font-size: .72rem; text-align: right; }
.rank-meta--danger { color: var(--hub-danger); }
.ranking-panel .panel-heading { gap: var(--hub-space-2); }
.ranking-segmented button { min-height: 1.75rem; padding-inline: .45rem; font-size: .68rem; }
.distribution-body { padding: .3rem var(--hub-panel-padding) .7rem; }
.distribution-row { min-height: 2.9rem; border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: minmax(3.5rem, 1fr) auto auto auto; align-items: center; gap: var(--hub-space-2); font-size: .74rem; }
.distribution-row:last-child { border-bottom: 0; }
.distribution-row code { min-width: 0; overflow: hidden; color: var(--hub-text); font-family: var(--hub-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.distribution-row strong { color: var(--hub-text); font-family: var(--hub-font-mono); font-weight: var(--hub-weight-medium); }
.distribution-row span, .distribution-row small { color: var(--hub-text-faint); white-space: nowrap; }
@media (max-width: 1180px) { .dashboard-grid { grid-template-columns: 1fr; } .health-panel { min-height: auto; } .rank-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ranking-panel { grid-column: 1 / -1; } }
@media (max-width: 850px) { .overview-page-actions { align-items: center; flex-direction: row; } .overview-page-actions > .app-select, .overview-page-actions > .button { width: auto; } .analytics-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } .analytics-filters .button { grid-column: 1 / -1; } .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .overview-page-actions { width: 100%; justify-content: flex-start; } .overview-period-scroller { width: 100%; max-width: 100%; } .chart-panel__heading { align-items: stretch; flex-direction: column; padding-block: var(--hub-space-3); } .chart-segmented { width: 100%; } .chart-segmented button { min-width: 0; flex: 1; } .rank-grid { grid-template-columns: 1fr; } .ranking-panel { grid-column: auto; } }
@media (max-width: 480px) { .overview-period-scroller { overflow-x: visible; } .overview-period-scroller button { min-width: 0; padding-inline: .3rem; flex: 1 1 0; } .overview-period-scroller button:nth-child(2) { flex-grow: 1.38; } .overview-period-scroller button:nth-child(7) { flex-grow: 1.14; } .analytics-filters { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: 1fr; } .alert-panel { grid-template-columns: auto minmax(0, 1fr); } .alert-panel > a { grid-column: 2; justify-self: start; } .ranking-panel .panel-heading { align-items: stretch; flex-direction: column; padding-block: var(--hub-space-3); } .ranking-segmented { width: 100%; } .ranking-segmented button { min-width: 0; flex: 1; } .distribution-row { grid-template-columns: minmax(0, 1fr) auto; } .distribution-row span, .distribution-row small { display: none; } }
</style>
