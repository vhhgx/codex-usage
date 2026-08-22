<script setup lang="ts">
import { IconCheck, IconCloudUpload, IconRefresh, IconShieldLock, IconTrash, IconUserPlus, IconX } from '@tabler/icons-vue'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '专属号池 | Zephyr Hub' })

interface Pool { id: string; displayName: string; status: string; maxAccounts: number | null; accountCount: number; availableAccountCount: number; lastError: string | null }
interface Account { id: string; displayName: string; email: string | null; platform: string; accountType: string; status: string; schedulable: boolean; source: string; lastVerifiedAt: number | null; lastError: string | null }
const { data, refresh } = await useFetch<{ pool: Pool | null; accounts: Account[] }>('/api/console/pool')
const provisioning = ref(false)
const importing = ref(false)
const verifying = ref<string | null>(null)
const deleting = ref<string | null>(null)
const importJson = ref('')
const notice = ref('')
const error = ref('')
const pool = computed(() => data.value?.pool || null)
const accounts = computed(() => data.value?.accounts || [])

async function provision() {
  provisioning.value = true; error.value = ''
  try { await $fetch('/api/console/pool/provision', { method: 'POST' }); await refresh() } catch (value) { error.value = value instanceof Error ? value.message : '创建号池失败' } finally { provisioning.value = false }
}
async function importAccount() {
  importing.value = true; error.value = ''; notice.value = ''
  try {
    const body = JSON.parse(importJson.value || '{}')
    await $fetch('/api/console/pool/accounts', { method: 'POST', body })
    importJson.value = ''; notice.value = '账号已导入，当前处于停用状态，请先验活。'; await refresh()
  } catch (value) { error.value = value instanceof Error ? value.message : '导入账号失败' } finally { importing.value = false }
}
async function toggle(account: Account) {
  error.value = ''
  try { await $fetch(`/api/console/pool/accounts/${account.id}`, { method: 'PATCH', body: { schedulable: !account.schedulable } }); await refresh() } catch (value) { error.value = value instanceof Error ? value.message : '更新账号失败' }
}
async function verify(account: Account) {
  verifying.value = account.id; error.value = ''
  try { await $fetch(`/api/console/pool/accounts/${account.id}/verify`, { method: 'POST' }); notice.value = '验活完成'; await refresh() } catch (value) { error.value = value instanceof Error ? value.message : '验活失败' } finally { verifying.value = null }
}
async function remove(account: Account) {
  deleting.value = account.id; error.value = ''
  try { await $fetch(`/api/console/pool/accounts/${account.id}`, { method: 'DELETE' }); await refresh() } catch (value) { error.value = value instanceof Error ? value.message : '删除账号失败' } finally { deleting.value = null }
}
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value) : '尚未验活'
</script>

<template>
  <div class="admin-page pool-page">
    <header class="admin-page__header"><div><span class="admin-kicker">PRIVATE RESOURCE</span><h1>专属号池</h1><p>套餐额度耗尽后，平台会继续使用你自己的账号。上游分组和凭据由 Hub 服务端隔离管理。</p></div><button v-if="!pool" class="button button--primary" :disabled="provisioning" @click="provision"><IconShieldLock :size="17" />{{ provisioning ? '创建中…' : '创建专属号池' }}</button></header>
    <div v-if="error" class="pool-alert pool-alert--error"><IconX :size="17" />{{ error }}</div><div v-if="notice" class="pool-alert pool-alert--ok"><IconCheck :size="17" />{{ notice }}</div>
    <template v-if="pool">
      <section class="admin-metrics pool-metrics"><article><span>号池状态</span><strong>{{ pool.status === 'active' ? '运行中' : '需处理' }}</strong><small>{{ pool.displayName }}</small></article><article><span>账号总数</span><strong>{{ pool.accountCount }}<em v-if="pool.maxAccounts"> / {{ pool.maxAccounts }}</em></strong><small>{{ pool.availableAccountCount }} 个可调度</small></article><article><span>资源边界</span><strong>仅自己</strong><small>不会跨用户故障转移</small></article></section>
      <section class="pool-layout"><article class="admin-panel"><header><div><span>ACCOUNT INVENTORY</span><h2>我的账号</h2></div><IconUserPlus :size="19" /></header><div v-if="accounts.length" class="pool-account-list"><div v-for="account in accounts" :key="account.id" class="pool-account"><div class="pool-account__mark" :data-active="account.schedulable"><IconCheck v-if="account.schedulable" :size="17" /><IconX v-else :size="17" /></div><div class="pool-account__main"><strong>{{ account.displayName }}</strong><span>{{ account.email || account.accountType }} · {{ account.platform }}</span><small>{{ account.lastError || `上次验活：${date(account.lastVerifiedAt)}` }}</small></div><span class="status-label" :data-status="account.schedulable ? 'active' : 'disabled'">{{ account.schedulable ? '调度中' : '已停用' }}</span><div class="pool-account__actions"><button class="icon-button" title="验活" :disabled="verifying === account.id" @click="verify(account)"><IconRefresh :size="17" /></button><button class="icon-button" :title="account.schedulable ? '停用' : '启用'" @click="toggle(account)"><IconX v-if="account.schedulable" :size="17" /><IconCheck v-else :size="17" /></button><button class="icon-button icon-button--danger" title="删除" :disabled="deleting === account.id" @click="remove(account)"><IconTrash :size="17" /></button></div></div></div><div v-else class="admin-empty"><p>还没有专属账号</p><small>导入完成后，账号会先经过验活再进入调度。</small></div></article>
        <article class="admin-panel pool-import"><header><div><span>IMPORT CREDENTIAL</span><h2>添加账号</h2></div><IconCloudUpload :size="19" /></header><p>提交 OAuth/PAT 或凭据字段。服务端会强制绑定当前专属分组，并写入 Codex 安全默认值。</p><textarea v-model="importJson" placeholder="{ &quot;name&quot;: &quot;我的账号&quot;, &quot;type&quot;: &quot;oauth&quot;, ... }" /><button class="button button--primary" :disabled="importing || !importJson.trim()" @click="importAccount"><IconCloudUpload :size="17" />{{ importing ? '导入中…' : '导入并停用' }}</button></article>
      </section>
    </template>
    <div v-else-if="!provisioning" class="admin-panel pool-empty"><IconShieldLock :size="26" /><h2>还没有专属号池</h2><p>启用后，管理员或你自己添加的账号只会进入你的专属分组。</p></div>
  </div>
</template>

<style scoped>
.pool-layout { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(300px,.8fr); gap:1rem; }
.pool-account-list { display:grid; gap:.6rem; }
.pool-account { display:grid; grid-template-columns:34px minmax(0,1fr) auto auto; align-items:center; gap:.8rem; padding:.8rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.pool-account__mark { width:30px; height:30px; display:grid; place-items:center; color:var(--text-muted); border:1px solid var(--line-subtle); }
.pool-account__mark[data-active="true"] { color:var(--accent); border-color:var(--accent); }
.pool-account__main { min-width:0; display:grid; gap:.15rem; }
.pool-account__main strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pool-account__main span,.pool-account__main small,.pool-import p { color:var(--text-muted); font-size:.78rem; }
.pool-account__actions { display:flex; gap:.2rem; }
.pool-import { display:grid; align-content:start; gap:.8rem; }
.pool-import textarea { min-height:180px; resize:vertical; font:13px var(--font-mono, monospace); color:var(--text); background:var(--surface-soft); border:1px solid var(--line-subtle); padding:.8rem; }
.pool-alert { display:flex; gap:.5rem; align-items:center; padding:.7rem .9rem; margin-bottom:1rem; border:1px solid; }
.pool-alert--error { color:#b42318; background:#fff5f4; border-color:#f4c7c3; }
.pool-alert--ok { color:#147d5a; background:#effaf5; border-color:#b8e3d2; }
.pool-empty { min-height:220px; display:grid; place-items:center; align-content:center; gap:.5rem; text-align:center; }
.pool-empty p { color:var(--text-muted); margin:0; }
@media (max-width: 820px) { .pool-layout { grid-template-columns:1fr; } .pool-account { grid-template-columns:30px minmax(0,1fr) auto; } .pool-account__actions { grid-column:2 / -1; justify-content:flex-end; } }
</style>
