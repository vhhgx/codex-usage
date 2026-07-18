<script setup lang="ts">
import {
  IconRefresh,
  IconServerBolt
} from '@tabler/icons-vue'
import type {
  CodexAccountView,
  CodexAccountsResponse,
  CodexQuotaResult,
  CodexRefreshAllResponse
} from '#shared/types/codex'

useSeoMeta({ title: 'Codex 余量 | Zephyr Console' })

const requestFetch = useRequestFetch()
const loadingAccounts = ref(true)
const refreshingAll = ref(false)
const error = ref('')
const accounts = ref<CodexAccountView[]>([])
const quotas = ref<Record<string, CodexQuotaResult>>({})
const loadingIds = ref(new Set<string>())

function errorMessage(value: unknown) {
  const status = value as {
    data?: { message?: string; statusMessage?: string }
    statusMessage?: string
    message?: string
  }
  return status.data?.message || status.data?.statusMessage || status.statusMessage || status.message || '操作失败，请稍后重试'
}

async function loadAccounts(autoRefresh = false) {
  loadingAccounts.value = true
  error.value = ''
  try {
    const response = await requestFetch<CodexAccountsResponse>('/api/codex/accounts')
    accounts.value = response.accounts
    if (autoRefresh && response.accounts.length) await refreshAll()
  } catch (value) {
    error.value = errorMessage(value)
  } finally {
    loadingAccounts.value = false
  }
}

async function refreshOne(id: string) {
  if (loadingIds.value.has(id)) return
  loadingIds.value = new Set(loadingIds.value).add(id)
  error.value = ''
  try {
    const result = await requestFetch<CodexQuotaResult>(`/api/codex/${encodeURIComponent(id)}/refresh`, {
      method: 'POST'
    })
    quotas.value = { ...quotas.value, [id]: result }
  } catch (value) {
    error.value = errorMessage(value)
  } finally {
    const next = new Set(loadingIds.value)
    next.delete(id)
    loadingIds.value = next
  }
}

async function refreshAll() {
  if (refreshingAll.value) return
  refreshingAll.value = true
  error.value = ''
  try {
    const response = await requestFetch<CodexRefreshAllResponse>('/api/codex/refresh-all', {
      method: 'POST'
    })
    const next = { ...quotas.value }
    response.results.forEach((item) => { next[item.id] = item })
    quotas.value = next
  } catch (value) {
    error.value = errorMessage(value)
  } finally {
    refreshingAll.value = false
  }
}

onMounted(() => loadAccounts(true))
</script>

<template>
  <div class="codex-page page-width">
    <section class="codex-heading">
      <div>
        <h1>Codex 余量</h1>
      </div>
      <div class="codex-heading__aside">
        <button class="button button--primary" type="button" :disabled="refreshingAll || !accounts.length" @click="refreshAll">
          <IconRefresh :size="18" :stroke-width="1.8" :class="{ 'is-spinning': refreshingAll }" />
          {{ refreshingAll ? '正在全部刷新' : '全部刷新' }}
        </button>
      </div>
    </section>

    <InlineNotice v-if="error" tone="error" title="额度查询未完成" :message="error" />

    <div v-if="loadingAccounts && !accounts.length" class="quota-board quota-board--loading">
      <div v-for="index in 4" :key="index" class="quota-ticket quota-ticket--placeholder" />
    </div>

    <div v-else-if="accounts.length" class="quota-board">
      <CodexQuotaCard
        v-for="account in accounts"
        :key="account.id"
        :account="account"
        :quota="quotas[account.id]"
        :loading="loadingIds.has(account.id) || refreshingAll"
        @refresh="refreshOne"
      />
    </div>

    <div v-else class="empty-state">
      <IconServerBolt :size="34" :stroke-width="1.5" />
      <h2>没有可用的 Codex 账号</h2>
      <p>请先在 CLIProxyAPI 中添加并启用 Codex OAuth 认证。</p>
      <button class="button button--secondary" type="button" @click="loadAccounts(true)">
        重新查询
      </button>
    </div>
  </div>
</template>
