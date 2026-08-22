<script setup lang="ts">
import {
  IconBrain,
  IconExternalLink,
  IconRefresh
} from '@tabler/icons-vue'
import type {
  CodexAccountView,
  CodexAccountsResponse,
  CodexQuotaResult,
  CodexRefreshAllResponse,
  QuotaWindowKind
} from '#shared/types/codex'
import type {
  Sub2ApiAccountQuotaResult,
  Sub2ApiAccountsResponse
} from '#shared/types/sub2api-admin'
import type { CodexRadarModel, CodexRadarResponse } from '#shared/types/codex-radar'
import {
  CODEX_RADAR_INTELLIGENCE_URL,
  CODEX_RADAR_URL,
  parseCodexRadarPayload
} from '#shared/utils/codex-radar'

withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const requestFetch = useRequestFetch()

const cpaInitialized = useState('account-quota-cpa-initialized', () => false)
const cpaLoadingAccounts = useState('account-quota-cpa-loading', () => true)
const cpaRefreshingAll = useState('account-quota-cpa-refreshing', () => false)
const cpaError = useState('account-quota-cpa-error', () => '')
const cpaAccounts = useState<CodexAccountView[]>('account-quota-cpa-accounts', () => [])
const cpaQuotas = useState<Record<string, CodexQuotaResult>>('account-quota-cpa-quotas', () => ({}))
const cpaLoadingIds = ref(new Set<string>())

const subInitialized = useState('account-quota-sub-initialized', () => false)
const subLoadingAccounts = useState('account-quota-sub-loading', () => true)
const subRefreshingAll = useState('account-quota-sub-refreshing', () => false)
const subError = useState('account-quota-sub-error', () => '')
const subResults = useState<Sub2ApiAccountQuotaResult[]>('account-quota-sub-results', () => [])
const subLoadingIds = ref(new Set<string>())

const radarInitialized = useState('account-quota-radar-initialized', () => false)
const radarLoading = useState('account-quota-radar-loading', () => true)
const radarError = useState('account-quota-radar-error', () => '')
const radar = useState<CodexRadarResponse | null>('account-quota-radar-data', () => null)
const upstreamRefreshing = computed(() => radarLoading.value || cpaRefreshingAll.value || subRefreshingAll.value)

function errorMessage(value: unknown) {
  const status = value as {
    data?: { message?: string; statusMessage?: string }
    statusMessage?: string
    message?: string
  }
  return status.data?.message || status.data?.statusMessage || status.statusMessage || status.message || '操作失败，请稍后重试'
}

async function loadCpaAccounts(autoRefresh = false) {
  cpaLoadingAccounts.value = true
  cpaError.value = ''
  try {
    const response = await requestFetch<CodexAccountsResponse>('/api/codex/accounts')
    cpaAccounts.value = response.accounts
    if (autoRefresh && response.accounts.length) await refreshAllCpa()
  } catch (value) {
    cpaError.value = errorMessage(value)
  } finally {
    cpaLoadingAccounts.value = false
  }
}

async function refreshOneCpa(id: string) {
  if (cpaLoadingIds.value.has(id)) return
  cpaLoadingIds.value = new Set(cpaLoadingIds.value).add(id)
  cpaError.value = ''
  try {
    const result = await requestFetch<CodexQuotaResult>(`/api/codex/${encodeURIComponent(id)}/refresh`, {
      method: 'POST'
    })
    cpaQuotas.value = { ...cpaQuotas.value, [id]: result }
  } catch (value) {
    cpaError.value = errorMessage(value)
  } finally {
    const next = new Set(cpaLoadingIds.value)
    next.delete(id)
    cpaLoadingIds.value = next
  }
}

async function refreshAllCpa() {
  if (cpaRefreshingAll.value) return
  cpaRefreshingAll.value = true
  cpaLoadingAccounts.value = true
  cpaError.value = ''
  try {
    const response = await requestFetch<CodexRefreshAllResponse>('/api/codex/refresh-all', {
      method: 'POST'
    })
    const resultsById = new Map(response.results.map((item) => [item.id, item]))
    cpaAccounts.value = response.accounts.map((account) => {
      const result = resultsById.get(account.id)
      return result
        ? {
            id: result.id,
            name: result.name,
            email: result.email,
            note: result.note,
            planType: result.planType,
            status: result.status,
            disabled: result.disabled,
            lastRefreshAt: result.lastRefreshAt
          }
        : account
    })
    const next: Record<string, CodexQuotaResult> = {}
    response.results.forEach((item) => { next[item.id] = item })
    cpaQuotas.value = next
  } catch (value) {
    cpaError.value = errorMessage(value)
  } finally {
    cpaRefreshingAll.value = false
    cpaLoadingAccounts.value = false
  }
}

function subWindowKind(id: string, label: string): QuotaWindowKind {
  const value = `${id} ${label}`.toLowerCase()
  if (/5.?小时|5h|five.?hour/.test(value)) return 'five-hour'
  if (/7.?天|每周|weekly|seven.?day/.test(value)) return 'weekly'
  if (/每月|monthly/.test(value)) return 'monthly'
  return 'other'
}

function subAccount(item: Sub2ApiAccountQuotaResult): CodexAccountView {
  return {
    id: item.id,
    name: item.name,
    email: null,
    note: item.notes,
    planType: item.planType || 'Sub2API',
    status: item.status,
    disabled: item.status !== 'active' || !item.schedulable,
    lastRefreshAt: item.refreshedAt
  }
}

function subQuota(item: Sub2ApiAccountQuotaResult): CodexQuotaResult {
  return {
    ...subAccount(item),
    quotaStatus: item.quotaStatus,
    windows: item.windows.map((window) => ({
      id: window.id,
      label: window.label,
      kind: subWindowKind(window.id, window.label),
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      resetAt: window.resetAt,
      windowSeconds: null
    })),
    refreshedAt: item.refreshedAt,
    ...(item.error || item.errorMessage ? { error: item.error || item.errorMessage || undefined } : {})
  }
}

const subCards = computed(() => subResults.value.map((item) => ({
  account: subAccount(item),
  quota: subQuota(item)
})))

const RADAR_EFFORT_ORDER = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low']

function radarModelLabel(model: string) { return model }

const radarGroups = computed(() => {
  const groups = new Map<string, CodexRadarModel[]>()
  radar.value?.models.forEach((model) => {
    const name = model.model.trim().toLowerCase()
    groups.set(name, [...(groups.get(name) || []), model])
  })

  return [...groups.entries()].map(([model, models]) => ({
    model,
    models: [...models].sort((left, right) => {
      const leftIndex = RADAR_EFFORT_ORDER.indexOf(left.reasoningEffort.toLowerCase())
      const rightIndex = RADAR_EFFORT_ORDER.indexOf(right.reasoningEffort.toLowerCase())
      return (leftIndex < 0 ? RADAR_EFFORT_ORDER.length : leftIndex) - (rightIndex < 0 ? RADAR_EFFORT_ORDER.length : rightIndex)
    })
  }))
})
const regularRadarGroups = computed(() => radarGroups.value.filter(group => group.models.length > 2))
const compactRadarGroups = computed(() => radarGroups.value.filter(group => group.models.length <= 2))

function updateSpotlight(event: PointerEvent) {
  if (!window.matchMedia('(min-width: 961px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches
    || window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return
  const element = event.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  element.style.setProperty('--spot-x', `${event.clientX - rect.left}px`)
  element.style.setProperty('--spot-y', `${event.clientY - rect.top}px`)
}

async function loadRadarDirect() {
  let lastError: unknown
  for (const url of [CODEX_RADAR_INTELLIGENCE_URL, CODEX_RADAR_URL]) {
    try {
      const payload = await $fetch<unknown>(url, { timeout: 10_000, retry: 0 })
      return parseCodexRadarPayload(payload)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function loadSubAccounts() {
  subLoadingAccounts.value = true
  subError.value = ''
  try {
    const response = await requestFetch<Sub2ApiAccountsResponse>('/api/sub2api/accounts')
    subResults.value = response.results
  } catch (value) {
    subError.value = errorMessage(value)
  } finally {
    subLoadingAccounts.value = false
  }
}

async function refreshOneSub(id: string) {
  if (subLoadingIds.value.has(id)) return
  subLoadingIds.value = new Set(subLoadingIds.value).add(id)
  subError.value = ''
  try {
    const updated = await requestFetch<Sub2ApiAccountQuotaResult>(`/api/sub2api/${encodeURIComponent(id)}/refresh`, {
      method: 'POST'
    })
    subResults.value = subResults.value.map((item) => item.id === id ? updated : item)
  } catch (value) {
    subError.value = errorMessage(value)
  } finally {
    const next = new Set(subLoadingIds.value)
    next.delete(id)
    subLoadingIds.value = next
  }
}

async function refreshAllSub() {
  if (subRefreshingAll.value) return
  subRefreshingAll.value = true
  subLoadingAccounts.value = true
  subError.value = ''
  try {
    const response = await requestFetch<Sub2ApiAccountsResponse>('/api/sub2api/refresh-all', {
      method: 'POST'
    })
    subResults.value = response.results
  } catch (value) {
    subError.value = errorMessage(value)
  } finally {
    subRefreshingAll.value = false
    subLoadingAccounts.value = false
  }
}

async function loadRadar() {
  if (radarLoading.value && radar.value) return
  radarLoading.value = true
  radarError.value = ''
  try {
    const requests: Array<Promise<CodexRadarResponse>> = [
      requestFetch<CodexRadarResponse>('/api/codex-radar')
    ]
    if (import.meta.client) {
      requests.push(loadRadarDirect())
    }
    radar.value = await Promise.any(requests)
  } catch (value) {
    radarError.value = '暂时无法连接 CodexRadar，请稍后重试'
  } finally {
    radarLoading.value = false
  }
}

async function refreshAllUpstreams() {
  await Promise.all([
    loadRadar(),
    ...(cpaAccounts.value.length ? [refreshAllCpa()] : []),
    ...(subResults.value.length ? [refreshAllSub()] : [])
  ])
}

function radarTimestamp(value: number | null | undefined) {
  if (!value) return '更新时间未知'
  return `更新于 ${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)}`
}

function radarScore(value: number) {
  return value.toFixed(1).replace(/\.0$/, '')
}

function radarPassRate(passed: number, tasks: number) {
  if (!tasks) return '-'
  return `${((passed / tasks) * 100).toFixed(1).replace(/\.0$/, '')}%`
}

onMounted(() => {
  if (!cpaInitialized.value) {
    cpaInitialized.value = true
    void loadCpaAccounts(true)
  }
  if (!subInitialized.value) {
    subInitialized.value = true
    void loadSubAccounts()
  }
  if (!radarInitialized.value) {
    radarInitialized.value = true
    void loadRadar()
  }
})
</script>

<template>
  <component :is="embedded ? 'section' : 'div'" :class="embedded ? 'upstream-section' : 'codex-page admin-page'" :aria-labelledby="embedded ? 'upstream-title' : undefined">
    <header v-if="!embedded" class="admin-page__header">
      <div>
        <span class="admin-kicker">ACCOUNT CAPACITY</span>
        <h1>账号余量</h1>
        <p>分别查看 CPA 与 Sub2API 的账号额度，并按数据源独立刷新。</p>
      </div>
    </header>
    <div v-else class="upstream-heading">
      <div><span>UPSTREAM CAPACITY</span><h2 id="upstream-title">上游账号余量</h2><p>CPA 与 Sub2API 账号额度及模型效率。</p></div>
      <button class="button button--quiet button--small" type="button" :disabled="upstreamRefreshing" @click="refreshAllUpstreams">
        <IconRefresh :size="16" :stroke-width="1.8" :class="{ 'is-spinning': upstreamRefreshing }" />
        {{ upstreamRefreshing ? '正在刷新' : '全部刷新' }}
      </button>
    </div>

    <section class="quota-source radar-source" aria-labelledby="radar-title">
      <header class="quota-source__header">
        <div>
          <h3 id="radar-title">Codex 模型智能效率</h3>
          <p>
            <a href="https://codexradar.com/" target="_blank" rel="noreferrer" class="radar-source__link">
              CodexRadar <IconExternalLink :size="13" :stroke-width="1.8" />
            </a>
            公共任务评分
          </p>
        </div>
        <div class="quota-source__actions radar-source__actions">
          <span class="radar-updated">{{ radarTimestamp(radar?.updatedAt) }}</span>
          <button class="button button--secondary button--small" type="button" :disabled="radarLoading" @click="loadRadar">
            <IconRefresh :size="16" :stroke-width="1.8" :class="{ 'is-spinning': radarLoading }" />
            {{ radarLoading ? '正在刷新' : '刷新评分' }}
          </button>
        </div>
      </header>

      <InlineNotice v-if="radarError" tone="error" title="CodexRadar 数据未更新" :message="radarError" />

      <div v-if="radarLoading && !radar" class="radar-loading-grid" aria-label="正在读取模型评分">
        <span v-for="index in 4" :key="index" />
      </div>

      <div v-else-if="radarGroups.length" class="radar-groups">
        <section v-for="group in regularRadarGroups" :key="group.model" class="glass-panel radar-group spotlight-panel" @pointermove="updateSpotlight">
          <header class="radar-group__header">
            <h4>{{ radarModelLabel(group.model) }}</h4>
            <span>{{ group.models.length }} 种推理强度</span>
          </header>
          <div v-for="model in group.models" :key="model.id" class="radar-row"><strong class="radar-row__score">{{ radarScore(model.intelligenceScore) }}</strong><div class="radar-row__mid"><span class="radar-row__effort">{{ model.reasoningEffort }}</span></div><div class="radar-row__stats"><strong>{{ radarPassRate(model.passed, model.tasks) }}</strong><span>{{ model.passed }} / {{ model.tasks }}</span></div></div>
        </section>
        <div v-if="compactRadarGroups.length" class="radar-group-stack">
          <section v-for="group in compactRadarGroups" :key="group.model" class="glass-panel radar-group spotlight-panel" @pointermove="updateSpotlight">
            <header class="radar-group__header"><h4>{{ radarModelLabel(group.model) }}</h4><span>{{ group.models.length }} 种推理强度</span></header>
            <div v-for="model in group.models" :key="model.id" class="radar-row"><strong class="radar-row__score">{{ radarScore(model.intelligenceScore) }}</strong><div class="radar-row__mid"><span class="radar-row__effort">{{ model.reasoningEffort }}</span></div><div class="radar-row__stats"><strong>{{ radarPassRate(model.passed, model.tasks) }}</strong><span>{{ model.passed }} / {{ model.tasks }}</span></div></div>
          </section>
        </div>
      </div>

      <div v-else-if="!radarError" class="empty-state empty-state--compact">
        <IconBrain :size="34" :stroke-width="1.5" />
        <h2>暂无模型评分</h2>
        <p>CodexRadar 当前没有返回可用的模型智能数据。</p>
        <button class="button button--secondary" type="button" @click="loadRadar">重新查询</button>
      </div>
    </section>

    <section v-if="cpaAccounts.length" id="cpa" class="quota-source" aria-labelledby="cpa-quota-title">
      <header class="quota-source__header">
        <div>
          <h3 id="cpa-quota-title">CPA Codex</h3>
          <p>CLIProxyAPI 中启用的 Codex OAuth 账号</p>
        </div>
        <div class="quota-source__actions">
          <span class="account-count">{{ cpaAccounts.length }} 个账号</span>
          <button class="button button--quiet button--small" type="button" :disabled="cpaRefreshingAll || cpaLoadingAccounts" @click="refreshAllCpa">
            <IconRefresh :size="16" :stroke-width="1.8" :class="{ 'is-spinning': cpaRefreshingAll }" />
            {{ cpaRefreshingAll ? '正在刷新' : '全部刷新' }}
          </button>
        </div>
      </header>

      <InlineNotice v-if="cpaError" tone="error" title="CPA 额度查询未完成" :message="cpaError" />

      <div class="quota-board">
        <CodexQuotaCard
          v-for="account in cpaAccounts"
          :key="account.id"
          :account="account"
          :quota="cpaQuotas[account.id]"
          :loading="cpaLoadingIds.has(account.id) || cpaRefreshingAll"
          @refresh="refreshOneCpa"
        />
      </div>
    </section>

    <section v-if="subResults.length" id="sub2api" class="quota-source" aria-labelledby="sub2api-quota-title">
      <header class="quota-source__header">
        <div>
          <h3 id="sub2api-quota-title">Sub2API</h3>
          <p>Sub2API 管理端中的上游账号</p>
        </div>
        <div class="quota-source__actions">
          <span class="account-count">{{ subResults.length }} 个账号</span>
          <button class="button button--quiet button--small" type="button" :disabled="subRefreshingAll || subLoadingAccounts" @click="refreshAllSub">
            <IconRefresh :size="16" :stroke-width="1.8" :class="{ 'is-spinning': subRefreshingAll }" />
            {{ subRefreshingAll ? '正在刷新' : '全部刷新' }}
          </button>
        </div>
      </header>

      <InlineNotice v-if="subError" tone="error" title="Sub2API 额度查询未完成" :message="subError" />

      <div class="quota-board">
        <CodexQuotaCard
          v-for="item in subCards"
          :key="item.account.id"
          :account="item.account"
          :quota="item.quota"
          :loading="subLoadingIds.has(item.account.id) || subRefreshingAll"
          @refresh="refreshOneSub"
        />
      </div>
    </section>
  </component>
</template>

<style scoped>
.upstream-section { margin-top: var(--hub-space-4); }
.upstream-heading { min-height: 69px; margin-bottom: var(--hub-grid-gap); display: flex; align-items: flex-end; justify-content: space-between; gap: var(--hub-space-4); }
.upstream-heading span { color: var(--hub-accent-bright); font-size: var(--hub-text-xs); font-weight: var(--hub-weight-medium); }
.upstream-heading h2 { margin-top: var(--hub-space-1); color: var(--hub-text); font-size: 1.05rem; font-weight: var(--hub-weight-semibold); }
.upstream-heading p { margin-top: var(--hub-space-1); color: var(--hub-text-muted); font-size: var(--hub-text-xs); }
.quota-source { margin-top: 1.35rem; padding: 0; border: 0; border-radius: 0; overflow: visible; background: transparent; box-shadow: none; }
.quota-source__header { min-height: 43px; margin-bottom: var(--hub-grid-gap); padding: 0; border: 0; display: flex; align-items: flex-end; justify-content: space-between; gap: var(--hub-space-4); }
.quota-source__header h3 { color: var(--hub-text); font-size: .86rem; font-weight: var(--hub-weight-semibold); }
.quota-source__header p { margin-top: .3rem; display: flex; align-items: center; gap: .35rem; color: var(--hub-text-faint); font-size: .72rem; }
.quota-source__actions { display: flex; align-items: center; gap: .55rem; flex: 0 0 auto; }
.radar-source__link { display: inline-flex; align-items: center; gap: .2rem; color: var(--hub-accent-bright); }
.radar-updated, .account-count { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .68rem; }
.radar-groups { margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--hub-grid-gap); }
.radar-group { min-width: 0; padding: .85rem .9rem .45rem; }
.radar-group-stack { min-width: 0; display: grid; align-content: start; gap: var(--hub-grid-gap); }
.radar-group__header { min-height: 0; padding-bottom: .55rem; border-bottom: 1px solid var(--hub-line); display: flex; align-items: baseline; justify-content: space-between; gap: .6rem; }
.radar-group__header h4 { min-width: 0; margin: 0; overflow: hidden; color: var(--hub-text); font-size: .95rem; font-weight: var(--hub-weight-semibold); line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.radar-group__header span { color: var(--hub-text-faint); font-size: .68rem; white-space: nowrap; }
.radar-row { padding: .56rem 0; border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: minmax(3.75rem, auto) minmax(0, 1fr) auto; align-items: center; gap: .65rem; }
.radar-row:last-child { border-bottom: 0; }
.radar-row__score { min-width: 3.75rem; color: var(--hub-text); font-family: var(--hub-font-mono); font-size: var(--hub-text-radar-score); font-weight: var(--hub-weight-medium); line-height: 1.5; }
.radar-row__mid { min-width: 0; display: flex; align-items: center; }
.radar-row__effort { padding: .14rem .42rem; border: 1px solid var(--hub-accent-line); border-radius: var(--hub-radius-xs); color: var(--hub-accent-text); background: var(--hub-accent-soft); font-family: var(--hub-font-mono); font-size: .62rem; }
.radar-row__stats { display: grid; gap: .18rem; text-align: right; }
.radar-row__stats strong { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .74rem; font-weight: var(--hub-weight-medium); }
.radar-row__stats span { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .62rem; }
.radar-loading-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--hub-grid-gap); }
.radar-loading-grid span { min-height: 384px; border-radius: var(--hub-radius-panel); background: var(--hub-skeleton); }
.quota-board { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: var(--hub-grid-gap); }
@media (max-width: 1180px) { .radar-groups, .radar-loading-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .upstream-heading, .quota-source__header { align-items: stretch; flex-direction: column; } .radar-source__actions { align-items: flex-end; flex-direction: column; } .radar-groups, .radar-loading-grid, .quota-board { grid-template-columns: 1fr; } }
</style>
