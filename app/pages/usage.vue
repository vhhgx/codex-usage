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
  CODEX_RADAR_URL,
  parseCodexRadarPayload
} from '#shared/utils/codex-radar'

useSeoMeta({ title: '账号余量 | Zephyr Console' })

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

function subScheduleStatus(item: Sub2ApiAccountQuotaResult): 'available' | 'paused' {
  return item.schedulable ? 'available' : 'paused'
}

const subCards = computed(() => subResults.value.map((item) => ({
  account: subAccount(item),
  quota: subQuota(item),
  scheduleStatus: subScheduleStatus(item)
})))

const radarModelOrder = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5']
const radarReasoningOrder = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']

function radarModelGroup(model: string) {
  const normalized = model.trim().toLowerCase()
  if (normalized === 'gpt-5.6' || normalized === '5.6' || normalized.endsWith('5.6-sol')) return 'gpt-5.6-sol'
  return radarModelOrder.find((name) => normalized === name || normalized.endsWith(name.slice(4))) || normalized
}

function radarModelLabel(model: string) {
  return model.replace(/^gpt-/i, '')
}

const radarGroups = computed(() => {
  const groups = new Map<string, CodexRadarModel[]>()
  radar.value?.models.forEach((model) => {
    const name = radarModelGroup(model.model)
    groups.set(name, [...(groups.get(name) || []), model])
  })

  return [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = radarModelOrder.indexOf(left)
      const rightIndex = radarModelOrder.indexOf(right)
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
      if (leftIndex === -1) return 1
      if (rightIndex === -1) return -1
      return leftIndex - rightIndex
    })
    .map(([model, models]) => ({
      model,
      models: models.sort((left, right) => {
        const leftIndex = radarReasoningOrder.indexOf(left.reasoningEffort.toLowerCase())
        const rightIndex = radarReasoningOrder.indexOf(right.reasoningEffort.toLowerCase())
        return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex)
      })
    }))
})

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
      requests.push(
        $fetch<unknown>(CODEX_RADAR_URL, { timeout: 10_000, retry: 0 })
          .then((payload) => parseCodexRadarPayload(payload))
      )
    }
    radar.value = await Promise.any(requests)
  } catch (value) {
    radarError.value = '暂时无法连接 CodexRadar，请稍后重试'
  } finally {
    radarLoading.value = false
  }
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
  <div class="codex-page page-width">
    <section class="page-heading">
      <div>
        <h1>账号余量</h1>
        <p>分别查看 CPA 与 Sub2API 的账号额度，并按数据源独立刷新。</p>
      </div>
    </section>

    <section class="quota-source radar-source" aria-labelledby="radar-title">
      <header class="quota-source__header">
        <div>
          <h2 id="radar-title">Codex 模型智能效率</h2>
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
        <section v-for="group in radarGroups" :key="group.model" class="radar-group">
          <header class="radar-group__header">
            <h3>{{ radarModelLabel(group.model) }}</h3>
            <span>{{ group.models.length }} 种推理强度</span>
          </header>
          <ul class="radar-list">
            <li v-for="model in group.models" :key="model.id">
              <div class="radar-list__primary">
                <strong>{{ radarScore(model.intelligenceScore) }}</strong>
                <span>{{ model.reasoningEffort }}</span>
              </div>
              <dl class="radar-list__stats">
                <div><dt>通过率</dt><dd>{{ radarPassRate(model.passed, model.tasks) }}</dd></div>
                <div><dt>通过数</dt><dd>{{ model.passed }}/{{ model.tasks }}</dd></div>
              </dl>
            </li>
          </ul>
        </section>
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
          <h2 id="cpa-quota-title">CPA Codex</h2>
          <p>CLIProxyAPI 中启用的 Codex OAuth 账号</p>
        </div>
        <div class="quota-source__actions">
          <span class="account-count">{{ cpaAccounts.length }} 个账号</span>
          <button class="button button--primary" type="button" :disabled="cpaRefreshingAll || cpaLoadingAccounts" @click="refreshAllCpa">
            <IconRefresh :size="18" :stroke-width="1.8" :class="{ 'is-spinning': cpaRefreshingAll }" />
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
          <h2 id="sub2api-quota-title">Sub2API</h2>
          <p>Sub2API 管理端中的上游账号</p>
        </div>
        <div class="quota-source__actions">
          <span class="account-count">{{ subResults.length }} 个账号</span>
          <button class="button button--primary" type="button" :disabled="subRefreshingAll || subLoadingAccounts" @click="refreshAllSub">
            <IconRefresh :size="18" :stroke-width="1.8" :class="{ 'is-spinning': subRefreshingAll }" />
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
          :schedule-status="item.scheduleStatus"
          :loading="subLoadingIds.has(item.account.id) || subRefreshingAll"
          @refresh="refreshOneSub"
        />
      </div>
    </section>
  </div>
</template>
