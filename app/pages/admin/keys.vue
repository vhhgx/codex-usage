<script setup lang="ts">
import {
  IconCalendarTime,
  IconActivity,
  IconChartBar,
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconEdit,
  IconEye,
  IconKey,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX
} from '@tabler/icons-vue'
import type { HubKeyDetailView, HubKeyUsagePeriod, HubKeyView, KeyActivityResponse } from '#shared/types/hub'
import type { HubGroupView, HubUserView } from '#shared/types/access-control'
import { activityLogQuery } from '#shared/utils/admin-log-query'
import { scheduleActivityRefresh } from '#shared/utils/activity-refresh'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Hub Keys | Zephyr Hub' })

const { data, refresh } = await useFetch<{ keys: HubKeyView[] }>('/api/admin/keys')
const { data: userData } = await useFetch<{ users: HubUserView[] }>('/api/admin/users')
const { data: groupData } = await useFetch<{ groups: HubGroupView[] }>('/api/admin/groups')
const { data: activity, refresh: refreshActivity } = await useFetch<KeyActivityResponse>('/api/admin/key-activity')
const search = ref('')
const route = useRoute()
const ownerFilter = ref(typeof route.query.owner === 'string' ? route.query.owner : '')
const groupFilter = ref('')
type ActivityMetric = 'requests' | 'tokens' | 'cost'
type ActivityFilter = 'all' | 'active' | 'recent' | 'inactive'
const activityMetrics: Array<{ id: ActivityMetric; label: string }> = [{ id: 'requests', label: '请求' }, { id: 'tokens', label: 'Token' }, { id: 'cost', label: '成本' }]
const activityFilters: Array<{ id: ActivityFilter; label: string }> = [{ id: 'all', label: '全部' }, { id: 'active', label: '今日活跃' }, { id: 'recent', label: '最近 5 分钟' }, { id: 'inactive', label: '今日未活跃' }]
const activityMetric = ref<ActivityMetric>('requests')
const activityFilter = ref<ActivityFilter>('all')
const activityRefreshing = ref(false)
const showForm = ref(false)
const saving = ref(false)
const error = ref('')
const revealedKey = ref('')
const copied = ref(false)
const editing = ref<HubKeyView | null>(null)
const detail = ref<HubKeyDetailView | null>(null)
const detailLoading = ref(false)
const rotating = ref(false)
const rotatedKey = ref('')
const rotationGraceSeconds = ref(3600)
const secretItem = ref<HubKeyView | null>(null)
const secretMode = ref<'reveal' | 'replace'>('reveal')
const secretPassword = ref('')
const replacementKey = ref('')
const secretValue = ref('')
const secretBusy = ref(false)
const secretError = ref('')
const endpointOptions = ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/images/generations', '/v1/images/edits']

type KeyForm = Record<string, string | string[]>
const emptyForm = (): KeyForm => ({
  name: '', note: '', expiresAt: '', expiresInDays: '', allowedModels: '', allowedEndpoints: [], rpmLimit: '60', concurrencyLimit: '5', priceMultiplier: '1',
  ownerUserId: '', groupId: '',
  totalRequestLimit: '', totalTokenLimit: '', totalCostLimit: '', dailyRequestLimit: '', dailyTokenLimit: '', dailyCostLimit: '',
  weeklyRequestLimit: '', weeklyTokenLimit: '', weeklyCostLimit: '', monthlyRequestLimit: '', monthlyTokenLimit: '', monthlyCostLimit: '',
  maxRequestTokens: '', maxRequestCost: '', maxImageCount: '', allowedImageSizes: '', allowedImageQualities: ''
})
const form = reactive<KeyForm>(emptyForm())
const filtered = computed(() => (data.value?.keys || []).filter(item => `${item.name} ${item.note || ''} ${item.maskedKey} ${item.ownerUserName || ''} ${item.groupName || ''}`.toLowerCase().includes(search.value.toLowerCase()) && (!ownerFilter.value || item.ownerUserId === ownerFilter.value) && (!groupFilter.value || item.groupId === groupFilter.value)))
const ownerGroups = computed(() => {
  const owner = userData.value?.users.find(user => user.id === form.ownerUserId)
  return (groupData.value?.groups || []).filter(group => owner?.groupIds.includes(group.id))
})
const filteredActivity = computed(() => (activity.value?.keys || []).filter(item => activityFilter.value === 'all' || activityFilter.value === 'active' && item.requests > 0 || activityFilter.value === 'recent' && item.recentlyActive || activityFilter.value === 'inactive' && item.requests === 0))
const currentActivityBucket = computed(() => {
  if (!activity.value || activity.value.generatedAt < activity.value.from || activity.value.generatedAt >= activity.value.to) return -1
  return activity.value.buckets.findIndex(bucket => activity.value!.generatedAt >= bucket.timestamp && activity.value!.generatedAt < bucket.endTimestamp)
})
const activityMaximum = computed(() => Math.max(0, ...(activity.value?.keys.flatMap(key => key.buckets.map(bucket => bucket[activityMetric.value])) || [0])))
let stopActivityRefresh: (() => void) | undefined

onMounted(() => { stopActivityRefresh = scheduleActivityRefresh(() => { void refreshActivity() }) })
onBeforeUnmount(() => stopActivityRefresh?.())

function timestamp(value: number | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value) : '永不过期'
}
function activityTime(value: number | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: activity.value?.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) : '今日无请求'
}
function activityValue(value: number) {
  if (activityMetric.value === 'cost') return money(value)
  return activityMetric.value === 'tokens' ? formatTokenCount(value) : compact(value)
}
function heatLevel(value: number) { return value <= 0 || activityMaximum.value <= 0 ? 0 : Math.max(1, Math.ceil(value / activityMaximum.value * 4)) }
function successRate(requests: number, successes: number) { return requests ? `${(successes / requests * 100).toFixed(1)}%` : '—' }
async function reloadActivity() {
  activityRefreshing.value = true
  try { await refreshActivity() } finally { activityRefreshing.value = false }
}
async function openActivityLogs(keyId: string, timestamp: number, endTimestamp: number) {
  await navigateTo({ path: '/admin/logs', query: activityLogQuery(keyId, timestamp, endTimestamp) })
}
function openCreate() { editing.value = null; Object.assign(form, emptyForm()); revealedKey.value = ''; error.value = ''; showForm.value = true }
function openEdit(item: HubKeyView) {
  editing.value = item
  const values: Record<string, unknown> = { ...item, allowedModels: item.allowedModels.join(', '), allowedImageSizes: item.allowedImageSizes.join(', '), allowedImageQualities: item.allowedImageQualities.join(', ') }
  Object.assign(form, emptyForm(), values, { expiresAt: item.expiresAt ? new Date(item.expiresAt).toISOString().slice(0, 16) : '' })
  revealedKey.value = ''; error.value = ''; showForm.value = true
}
watch(() => form.ownerUserId, () => {
  if (form.groupId && !ownerGroups.value.some(group => group.id === form.groupId)) form.groupId = ''
})
function setExpiry(days: number) {
  if (!editing.value) {
    form.expiresInDays = String(days)
    form.expiresAt = ''
    return
  }
  const value = new Date(Date.now() + days * 86400_000)
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset())
  form.expiresAt = value.toISOString().slice(0, 16)
}
function payload() {
  const numeric = ['rpmLimit','concurrencyLimit','priceMultiplier','totalRequestLimit','totalTokenLimit','totalCostLimit','dailyRequestLimit','dailyTokenLimit','dailyCostLimit','weeklyRequestLimit','weeklyTokenLimit','weeklyCostLimit','monthlyRequestLimit','monthlyTokenLimit','monthlyCostLimit','maxRequestTokens','maxRequestCost','maxImageCount']
  const result: Record<string, unknown> = { ...form, expiresAt: form.expiresAt ? new Date(String(form.expiresAt)).toISOString() : null, allowedModels: String(form.allowedModels).split(',').map(v => v.trim()).filter(Boolean) }
  result.allowedImageSizes = String(form.allowedImageSizes).split(',').map(v => v.trim()).filter(Boolean)
  result.allowedImageQualities = String(form.allowedImageQualities).split(',').map(v => v.trim()).filter(Boolean)
  result.expiresInDays = !editing.value && form.expiresInDays ? Number(form.expiresInDays) : null
  numeric.forEach(key => { result[key] = form[key] === '' ? null : Number(form[key]) })
  return result
}
async function save() {
  saving.value = true; error.value = ''
  try {
    if (editing.value) await $fetch(`/api/admin/keys/${editing.value.id}`, { method: 'PATCH', body: payload() })
    else {
      const result = await $fetch<{ key: string }>('/api/admin/keys', { method: 'POST', body: payload() })
      revealedKey.value = result.key
    }
    await Promise.all([refresh(), refreshActivity()])
    if (editing.value) showForm.value = false
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '保存失败'
  } finally { saving.value = false }
}
async function toggle(item: HubKeyView) { await $fetch(`/api/admin/keys/${item.id}`, { method: 'PATCH', body: { status: item.status === 'active' ? 'disabled' : 'active' } }); await Promise.all([refresh(), refreshActivity()]) }
async function remove(item: HubKeyView) { if (!confirm(`确定永久删除 ${item.name}？历史日志会保留。`)) return; await $fetch(`/api/admin/keys/${item.id}`, { method: 'DELETE' }); await Promise.all([refresh(), refreshActivity()]) }
async function copySecret(value: string) { await navigator.clipboard.writeText(value); copied.value = true; window.setTimeout(() => { copied.value = false }, 1800) }
async function copyKey() { await copySecret(revealedKey.value) }
function openSecret(item: HubKeyView, mode: 'reveal' | 'replace') {
  secretItem.value = item; secretMode.value = mode; secretPassword.value = ''; replacementKey.value = ''; secretValue.value = ''; secretError.value = ''
}
async function submitSecret() {
  if (!secretItem.value) return
  secretBusy.value = true; secretError.value = ''
  try {
    if (secretMode.value === 'reveal') {
      const result = await $fetch<{ key: string }>(`/api/admin/keys/${secretItem.value.id}/reveal`, { method: 'POST', body: { password: secretPassword.value } })
      secretValue.value = result.key
    } else {
      const result = await $fetch<{ key: string }>(`/api/admin/keys/${secretItem.value.id}/secret`, { method: 'PUT', body: { password: secretPassword.value, key: replacementKey.value, graceSeconds: 0 } })
      secretValue.value = result.key
      await refresh()
    }
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; secretError.value = failure.data?.message || failure.message || '操作失败' }
  finally { secretBusy.value = false }
}
async function openUsage(item: HubKeyView) {
  detailLoading.value = true
  detail.value = null
  try { detail.value = await $fetch<HubKeyDetailView>(`/api/admin/keys/${item.id}`); rotatedKey.value = '' }
  finally { detailLoading.value = false }
}
async function rotateCredential() {
  if (!detail.value) return
  rotating.value = true
  try {
    const result = await $fetch<{ key: string }>(`/api/admin/keys/${detail.value.item.id}/rotate`, { method: 'POST', body: { graceSeconds: rotationGraceSeconds.value } })
    rotatedKey.value = result.key
    detail.value = await $fetch<HubKeyDetailView>(`/api/admin/keys/${detail.value.item.id}`)
    await refresh()
  } finally { rotating.value = false }
}
async function revokeCredential(credentialId: string) {
  if (!detail.value) return
  await $fetch(`/api/admin/keys/${detail.value.item.id}/credentials/${credentialId}`, { method: 'DELETE' })
  detail.value = await $fetch<HubKeyDetailView>(`/api/admin/keys/${detail.value.item.id}`)
}
function compact(value: number) { return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value) }
function money(value: number) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 5 : 2 }).format(value) }
function periodLabel(period: HubKeyUsagePeriod) { return ({ all: '全部时间', today: '今日', week: '本周', month: '本月' } as const)[period.id] }
function periodLimit(item: HubKeyView, period: HubKeyUsagePeriod, metric: 'Request' | 'Token' | 'Cost') {
  const prefix = period.id === 'all' ? 'total' : period.id === 'today' ? 'daily' : period.id === 'week' ? 'weekly' : 'monthly'
  return item[`${prefix}${metric}Limit` as keyof HubKeyView] as number | null
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">ACCESS CONTROL</span><h1>Hub Keys</h1><p>分发访问凭据，并在入口执行到期、模型、速率与额度限制。</p></div><button class="button button--primary" @click="openCreate"><IconPlus :size="18" /> 创建 Key</button></header>
    <section class="key-activity-panel">
      <header class="key-activity-header">
        <div><span>LIVE KEY ACTIVITY</span><h2>今日 Key 活跃度</h2><small>{{ activity?.activeCount || 0 }} 个今日活跃 · {{ activity?.recentlyActiveCount || 0 }} 个最近 5 分钟活跃</small></div>
        <div class="key-activity-actions">
          <div class="admin-page-tabs admin-page-tabs--embedded" role="tablist" aria-label="热力指标"><button v-for="item in activityMetrics" :key="item.id" type="button" role="tab" :aria-selected="activityMetric === item.id" :class="{ active: activityMetric === item.id }" @click="activityMetric = item.id">{{ item.label }}</button></div>
          <button class="icon-button" title="刷新活跃度" aria-label="刷新活跃度" :disabled="activityRefreshing" @click="reloadActivity"><IconRefresh :class="{ 'is-spinning': activityRefreshing }" :size="17" /></button>
        </div>
      </header>
      <div class="key-activity-filters">
        <div class="admin-page-tabs admin-page-tabs--embedded" role="tablist" aria-label="活跃度筛选"><button v-for="item in activityFilters" :key="item.id" type="button" role="tab" :aria-selected="activityFilter === item.id" :class="{ active: activityFilter === item.id }" @click="activityFilter = item.id">{{ item.label }}</button></div>
        <span>更新于 {{ activityTime(activity?.generatedAt || null) }} · {{ activity?.timezone }}</span>
      </div>
      <div class="key-activity-scroll">
        <table class="key-activity-table">
          <thead><tr><th class="activity-key-column">Key</th><th class="activity-count-column">请求</th><th class="activity-rate-column">成功率</th><th class="activity-last-column">最后请求</th><th v-for="(bucket, index) in activity?.buckets || []" :key="bucket.timestamp" :class="{ current: currentActivityBucket === index }">{{ bucket.label.split(' ')[0] }}</th></tr></thead>
          <tbody>
            <tr v-for="item in filteredActivity" :key="item.id">
              <td class="activity-key-column"><div><span :class="{ recent: item.recentlyActive }"><IconActivity :size="14" /></span><p><strong>{{ item.name }}</strong><code>{{ item.maskedKey }}</code></p></div></td>
              <td class="activity-count-column"><strong>{{ compact(item.requests) }}</strong><small v-if="item.pending">{{ item.pending }} 进行中</small></td>
              <td class="activity-rate-column">{{ successRate(item.requests, item.successes) }}</td>
              <td class="activity-last-column">{{ activityTime(item.lastSeenAt) }}</td>
              <td v-for="(bucket, index) in item.buckets" :key="bucket.timestamp" class="activity-hour" :class="[`heat-${heatLevel(bucket[activityMetric])}`, { current: currentActivityBucket === index }]">
                <button :title="`${bucket.label} · ${activityValue(bucket[activityMetric])}`" @click="openActivityLogs(item.id, bucket.timestamp, bucket.endTimestamp)">{{ bucket[activityMetric] ? activityValue(bucket[activityMetric]) : '' }}</button>
              </td>
            </tr>
            <tr v-if="!filteredActivity.length"><td colspan="28"><div class="admin-empty">当前筛选下没有 Key</div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="admin-toolbar"><label class="admin-search"><IconSearch :size="17" /><input v-model="search" placeholder="搜索名称、用户、分组或 Key"></label><AppSelect v-model="ownerFilter"><option value="">全部用户</option><option v-for="user in userData?.users || []" :key="user.id" :value="user.id">{{ user.displayName || user.username }}</option></AppSelect><AppSelect v-model="groupFilter"><option value="">全部分组</option><option v-for="group in groupData?.groups || []" :key="group.id" :value="group.id">{{ group.name }}</option></AppSelect><span>{{ filtered.length }} / {{ data?.keys.length || 0 }} 个 Key</span></section>
    <section class="admin-table-wrap">
      <table class="admin-table"><thead><tr><th>Key</th><th>用户 / 分组</th><th>状态</th><th>权限</th><th>速率</th><th>到期时间</th><th>最近使用</th><th aria-label="操作" /></tr></thead>
        <tbody><tr v-for="item in filtered" :key="item.id">
          <td><div class="table-primary"><span class="key-glyph"><IconKey :size="16" /></span><div><strong>{{ item.name }}</strong><code>{{ item.maskedKey }}</code><small v-if="item.note">{{ item.note }}</small></div></div></td>
          <td><strong>{{ item.ownerUserName || '未归属' }}</strong><small class="table-sub">{{ item.groupName || '未分组' }}</small></td>
          <td><span class="status-dot" :data-status="item.status"><i />{{ item.status === 'active' ? '运行中' : item.status === 'expired' ? '已到期' : '已停用' }}</span></td>
          <td><strong>{{ item.allowedModels.length || '全部' }}</strong><small class="table-sub">个模型 · {{ item.allowedEndpoints.length || '全部' }} 个端点</small></td>
          <td><code>{{ item.rpmLimit || '∞' }} RPM</code><small class="table-sub">{{ item.concurrencyLimit || '∞' }} 并发</small></td>
          <td><span class="table-date"><IconCalendarTime :size="15" />{{ timestamp(item.expiresAt) }}</span></td>
          <td>{{ timestamp(item.lastUsedAt) }}</td>
          <td><div class="table-actions"><button class="icon-button" title="查看完整 Key" aria-label="查看完整 Key" :disabled="!item.revealable" @click="openSecret(item, 'reveal')"><IconEye :size="17" /></button><button class="icon-button" title="设置完整 Key" aria-label="设置完整 Key" @click="openSecret(item, 'replace')"><IconKey :size="16" /></button><button class="icon-button" title="用量详情" aria-label="用量详情" @click="openUsage(item)"><IconChartBar :size="17" /></button><button class="icon-button" :title="item.status === 'active' ? '停用' : '启用'" :aria-label="item.status === 'active' ? '停用 Key' : '启用 Key'" @click="toggle(item)"><IconDotsVertical :size="17" /></button><button class="icon-button" title="编辑策略" aria-label="编辑策略" @click="openEdit(item)"><IconEdit :size="16" /></button><button class="icon-button danger" title="删除" aria-label="删除 Key" @click="remove(item)"><IconTrash :size="16" /></button></div></td>
        </tr><tr v-if="!filtered.length"><td colspan="8"><div class="admin-empty">没有匹配的 Hub Key</div></td></tr></tbody>
      </table>
    </section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false">
      <section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true">
        <header><div><span>HUB KEY</span><h2>{{ editing ? '编辑访问策略' : '创建访问凭据' }}</h2></div><button class="icon-button" title="关闭" aria-label="关闭" @click="showForm = false"><IconX :size="18" /></button></header>
        <div v-if="revealedKey" class="secret-reveal"><IconCheck :size="21" /><div><strong>Hub Key 已创建</strong><code>{{ revealedKey }}</code><small>以后仍可通过“查看完整 Key”获取。</small></div><button class="button button--secondary" @click="copyKey"><IconCheck v-if="copied" :size="17" /><IconCopy v-else :size="17" />{{ copied ? '已复制' : '复制' }}</button></div>
        <form v-else class="admin-form" @submit.prevent="save">
          <div class="form-grid"><label><span>名称 *</span><input v-model="form.name" required placeholder="例如：研发团队"></label><label><span>备注</span><input v-model="form.note" placeholder="用途或负责人"></label></div>
          <div class="form-grid"><label><span>所属用户 *</span><AppSelect v-model="form.ownerUserId" required><option value="" disabled>选择用户</option><option v-for="user in userData?.users || []" :key="user.id" :value="user.id">{{ user.displayName || user.username }}</option></AppSelect></label><label><span>所属分组 *</span><AppSelect v-model="form.groupId" required><option value="" disabled>选择该用户所属分组</option><option v-for="group in ownerGroups" :key="group.id" :value="group.id">{{ group.name }}</option></AppSelect></label></div>
          <div class="form-grid form-grid--expiry"><label><span>到期时间</span><input v-model="form.expiresAt" type="datetime-local" @input="form.expiresInDays = ''"></label><div class="expiry-presets"><span>{{ editing ? '从现在起' : '创建后到期' }}</span><div><button v-for="days in [1, 7, 30]" :key="days" type="button" :class="{ active: form.expiresInDays === String(days) }" @click="setExpiry(days)">{{ days }} 天</button><button type="button" @click="form.expiresAt = ''; form.expiresInDays = ''">永久</button></div></div></div>
          <div class="form-grid"><label><span>允许模型（逗号分隔，留空为全部）</span><input v-model="form.allowedModels" placeholder="gpt-5.4, gpt-image-1.5"></label><label><span>价格倍率</span><input v-model="form.priceMultiplier" type="number" min="0" step="0.01"></label></div>
          <fieldset class="endpoint-picker"><legend>允许端点（不选择表示全部）</legend><label v-for="endpoint in endpointOptions" :key="endpoint"><input v-model="form.allowedEndpoints" type="checkbox" :value="endpoint"><span>{{ endpoint.replace('/v1/', '') }}</span></label></fieldset>
          <section class="form-section"><header><h3>速率限制</h3><span>留空表示无限制</span></header><div class="form-grid"><label><span>每分钟请求数</span><input v-model="form.rpmLimit" type="number" min="1"></label><label><span>最大并发</span><input v-model="form.concurrencyLimit" type="number" min="1"></label></div></section>
          <section class="form-section"><header><h3>周期额度</h3><span>请求 / Token / USD</span></header><div class="quota-form-grid">
            <template v-for="period in [{id:'total',label:'总额度'},{id:'daily',label:'每日'},{id:'weekly',label:'每周'},{id:'monthly',label:'每月'}]" :key="period.id"><strong>{{ period.label }}</strong><input v-model="form[`${period.id}RequestLimit`]" type="number" min="1" placeholder="请求数"><input v-model="form[`${period.id}TokenLimit`]" type="number" min="1" placeholder="Token"><input v-model="form[`${period.id}CostLimit`]" type="number" min="0" step="0.01" placeholder="USD"></template>
          </div></section>
          <section class="form-section"><header><h3>单请求保护</h3><span>留空表示不限制</span></header><div class="form-grid"><label><span>最大预计 Token</span><input v-model="form.maxRequestTokens" type="number" min="1"></label><label><span>最高预计成本（USD）</span><input v-model="form.maxRequestCost" type="number" min="0" step="0.01"></label></div><div class="form-grid"><label><span>最大图片数量</span><input v-model="form.maxImageCount" type="number" min="1"></label><label><span>允许图片规格</span><input v-model="form.allowedImageSizes" placeholder="1024x1024, 1536x1024"></label></div><div class="form-grid"><label><span>允许图片质量</span><input v-model="form.allowedImageQualities" placeholder="auto, high"></label></div></section>
          <p v-if="error" class="form-error">{{ error }}</p>
          <footer><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '正在保存' : editing ? '保存修改' : '创建 Key' }}</button></footer>
        </form>
      </section>
    </div>

    <div v-if="secretItem" class="admin-modal-backdrop" @click.self="secretItem = null"><section class="admin-modal" role="dialog" aria-modal="true"><header><div><span>KEY SECRET</span><h2>{{ secretMode === 'reveal' ? '查看完整 Key' : '设置完整 Key 值' }}</h2></div><button class="icon-button" title="关闭" aria-label="关闭" @click="secretItem = null"><IconX :size="18" /></button></header><form class="admin-form" @submit.prevent="submitSecret"><p><strong>{{ secretItem.name }}</strong> · <code>{{ secretItem.maskedKey }}</code></p><label><span>当前管理员密码</span><input v-model="secretPassword" type="password" autocomplete="current-password" required></label><label v-if="secretMode === 'replace'"><span>新的完整 Key</span><input v-model="replacementKey" type="password" minlength="16" maxlength="512" autocomplete="off" required></label><div v-if="secretValue" class="credential-secret"><code>{{ secretValue }}</code><button type="button" class="button button--secondary button--small" @click="copySecret(secretValue)"><IconCopy :size="15" />{{ copied ? '已复制' : '复制' }}</button></div><p v-if="secretError" class="form-error">{{ secretError }}</p><footer><button type="button" class="button button--secondary" @click="secretItem = null">关闭</button><button v-if="!secretValue" class="button button--primary" :disabled="secretBusy">{{ secretBusy ? '处理中' : secretMode === 'reveal' ? '验证并查看' : '验证并设置' }}</button></footer></form></section></div>

    <div v-if="detail || detailLoading" class="log-drawer-backdrop" @click.self="detail = null">
      <aside class="log-drawer key-usage-drawer">
        <header><div><span>KEY USAGE</span><code>{{ detail?.item.maskedKey || '正在载入…' }}</code></div><button class="icon-button" title="关闭" aria-label="关闭" @click="detail = null"><IconX :size="18" /></button></header>
        <template v-if="detail">
          <section class="key-usage-identity"><span class="key-glyph"><IconKey :size="17" /></span><div><h2>{{ detail.item.name }}</h2><p>{{ detail.item.note || '无备注' }}</p></div><span class="status-dot" :data-status="detail.item.status"><i />{{ detail.item.status }}</span></section>
          <section class="key-usage-periods">
            <article v-for="period in detail.periods" :key="period.id"><header><strong>{{ periodLabel(period) }}</strong><span>{{ period.successRate === null ? '—' : `${period.successRate.toFixed(1)}%` }} 成功</span></header><dl><div><dt>准入请求</dt><dd>{{ compact(period.admittedRequests) }}<small v-if="periodLimit(detail.item, period, 'Request')"> / {{ compact(periodLimit(detail.item, period, 'Request')!) }}</small><small v-if="period.requests !== period.admittedRequests"> · 总计 {{ compact(period.requests) }}</small></dd></div><div><dt>Token</dt><dd>{{ formatTokenCount(period.tokens) }}<small v-if="periodLimit(detail.item, period, 'Token')"> / {{ formatTokenCount(periodLimit(detail.item, period, 'Token')!) }}</small></dd></div><div><dt>成本</dt><dd>{{ money(period.cost) }}<small v-if="periodLimit(detail.item, period, 'Cost')"> / {{ money(periodLimit(detail.item, period, 'Cost')!) }}</small></dd></div></dl></article>
          </section>
          <section class="key-credentials"><header><div><h3>凭据版本</h3><span>{{ detail.credentials.length }} 个</span></div><div><AppSelect v-model.number="rotationGraceSeconds"><option :value="0">立即切换</option><option :value="3600">重叠 1 小时</option><option :value="86400">重叠 24 小时</option></AppSelect><button class="button button--secondary button--small" :disabled="rotating" @click="rotateCredential"><IconRefresh :class="{ 'is-spinning': rotating }" :size="15" />{{ rotating ? '轮换中' : '轮换 Key' }}</button></div></header><div v-if="rotatedKey" class="credential-secret"><code>{{ rotatedKey }}</code><button class="button button--quiet button--small" @click="copySecret(rotatedKey)"><IconCopy :size="15" />{{ copied ? '已复制' : '复制' }}</button></div><div v-for="credential in detail.credentials" :key="credential.id" class="credential-row"><div><code>{{ credential.maskedKey }}</code><small>{{ credential.current ? '当前凭据' : credential.expiresAt ? `有效至 ${timestamp(credential.expiresAt)}` : '有效' }} · {{ credential.lastUsedAt ? `最后使用 ${timestamp(credential.lastUsedAt)}` : '尚未使用' }}</small></div><span class="status-dot" :data-status="credential.status"><i />{{ credential.status }}</span><button v-if="!credential.current && credential.status === 'active'" class="icon-button danger" title="吊销凭据" aria-label="吊销凭据" @click="revokeCredential(credential.id)"><IconTrash :size="15" /></button></div></section>
          <section class="key-usage-recent"><header><h3>最近请求</h3><span>{{ detail.recentRequests.length }} 条</span></header><div v-for="request in detail.recentRequests" :key="request.id"><code>{{ request.requestId }}</code><span>{{ request.requestedModel || '—' }}</span><strong :data-status="request.status">{{ request.httpStatus || '—' }}</strong><small>{{ request.durationMs === null ? '—' : `${request.durationMs}ms` }}</small></div><p v-if="!detail.recentRequests.length">尚无请求记录</p></section>
        </template>
      </aside>
    </div>
  </div>
</template>
