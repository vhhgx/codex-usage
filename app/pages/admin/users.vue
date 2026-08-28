<script setup lang="ts">
import {
  IconActivity,
  IconBraces,
  IconChartBar,
  IconCoin,
  IconCopy,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconGauge,
  IconKey,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconShieldCheck,
  IconTrash,
  IconUser,
  IconUsers,
  IconX
} from '@tabler/icons-vue'
import type { Component } from 'vue'
import type { HubGroupView, HubUserView, UserRole, UserStatus } from '#shared/types/access-control'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '用户管理 | Zephyr Hub' })

interface ManagedUserView extends HubUserView {
  subscription: null | { planId: string; planName: string; status: string }
}

interface PlanData {
  plans: Array<{ id: string; name: string; status: string; description?: string | null }>
}

interface UserKeyView {
  id: string
  name: string
  maskedKey: string
  status: string
  groupId: string | null
  lastUsedAt: number | null
}

interface UserDetailView {
  user: HubUserView
  usage: { requests: number; tokens: number; cost: number }
  keys: UserKeyView[]
  recent: Array<{ id: string; requestId: string; model: string | null; status: string; httpStatus: number | null; createdAt: number }>
}

const roleOptions: Array<{ value: UserRole; label: string; hint: string; icon: Component }> = [
  { value: 'user', label: '用户', hint: '默认访问权限', icon: IconUser },
  { value: 'admin', label: '管理员', hint: '管理业务资源', icon: IconShieldCheck }
]

const roleFilterOptions = [
  { value: '', label: '全部角色' },
  ...roleOptions.map(({ value, label }) => ({ value, label }))
]

const statusFilterOptions = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' }
]

const roleLabels: Record<UserRole, string> = {
  user: '用户',
  operator: '管理员',
  auditor: '管理员',
  admin: '管理员',
  super_admin: '管理员'
}

const statusLabels: Record<UserStatus, string> = {
  active: '启用',
  disabled: '停用',
  locked: '停用'
}

const { data, pending: usersPending, error: usersError, refresh } = await useFetch<{ users: ManagedUserView[] }>('/api/admin/users')
const { data: groupData, refresh: refreshGroups } = await useFetch<{ groups: HubGroupView[] }>('/api/admin/groups')
const { data: planData, refresh: refreshPlans } = await useFetch<PlanData>('/api/admin/plans')
const { show: showToast } = useAppToast()

const search = ref('')
const roleFilter = ref('')
const statusFilter = ref('')
const groupFilter = ref('')
const editing = ref<ManagedUserView | null>(null)
const showForm = ref(false)
const saving = ref(false)
const formError = ref('')
const resetPassword = ref('')
const showPassword = ref(false)
const detailUser = ref<HubUserView | null>(null)
const detail = ref<UserDetailView | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const copyingUserKeyId = ref<string | null>(null)
const deletingUser = ref<HubUserView | null>(null)
const deleting = ref(false)
const selectedPlanId = ref('00000000-0000-4000-8000-000000000002')
const originalPlanId = ref('')
const originalRole = ref<UserRole>('user')
const form = reactive({
  username: '',
  displayName: '',
  email: '',
  password: '',
  platformAccessExpiresAt: '',
  role: 'user' as UserRole,
  status: 'active' as UserStatus,
  groupIds: [] as string[]
})

const statusEnabled = computed({
  get: () => form.status === 'active',
  set: (enabled: boolean) => { form.status = enabled ? 'active' : 'disabled' }
})

function uiRole(value: UserRole | string) {
  return value === 'user' ? 'user' : 'admin'
}

function uiStatus(value: UserStatus | string) {
  return value === 'active' ? 'active' : 'disabled'
}

async function copyUserKey(key: UserKeyView) {
  copyingUserKeyId.value = key.id
  try {
    const result = await $fetch<{ key: string }>(`/api/admin/keys/${key.id}/reveal`, { method: 'POST', body: {} })
    await navigator.clipboard.writeText(result.key)
    showToast('Key 已复制', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    showToast(failure.data?.message || failure.message || '复制 Key 失败', 'error')
  } finally { copyingUserKeyId.value = null }
}

const filtered = computed(() => (data.value?.users || []).filter(user => {
  const needle = search.value.trim().toLowerCase()
  return (!needle || `${user.username} ${user.displayName || ''} ${user.email || ''}`.toLowerCase().includes(needle))
    && (!roleFilter.value || uiRole(user.role) === roleFilter.value)
    && (!statusFilter.value || uiStatus(user.status) === statusFilter.value)
    && (!groupFilter.value || user.groupIds.includes(groupFilter.value))
}))

const activeGroups = computed(() => (groupData.value?.groups || []).filter(group => group.status === 'active'))
const activePlans = computed(() => (planData.value?.plans || []).filter(plan => plan.status === 'active'))
const groupChoiceOptions = computed(() => activeGroups.value.map(group => ({
  value: group.id,
  label: group.name,
  hint: `${group.keyCount} 个 Key · ${group.description || '管理访问分组'}`,
  icon: IconRoute
})))
const planChoiceOptions = computed(() => activePlans.value.map((plan, index) => ({
  value: plan.id,
  label: plan.name,
  hint: plan.description || '按当前套餐策略提供访问额度',
  icon: planIcon(index)
})))
const groupFilterOptions = computed(() => [
  { value: '', label: '全部分组' },
  ...(groupData.value?.groups || []).map(group => ({ value: group.id, label: group.name }))
])
const detailIdentity = computed(() => detail.value?.user || detailUser.value)

function defaultPlanId() {
  return activePlans.value.find(plan => plan.id === '00000000-0000-4000-8000-000000000002')?.id
    || activePlans.value[0]?.id
    || ''
}

function localDateTime(value: number | null) {
  if (!value) return ''
  const date = new Date(value)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function setPlatformExpiry(days: number) {
  const value = new Date(Date.now() + days * 86400_000)
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset())
  form.platformAccessExpiresAt = value.toISOString().slice(0, 16)
}

function resetForm() {
  Object.assign(form, { username: '', displayName: '', email: '', password: '', platformAccessExpiresAt: '', role: 'user', status: 'active', groupIds: [] })
  resetPassword.value = ''
  showPassword.value = false
  formError.value = ''
  selectedPlanId.value = defaultPlanId()
  originalPlanId.value = ''
  originalRole.value = 'user'
}

function closeForm() {
  if (!saving.value) showForm.value = false
}

function openCreate() {
  closeDetail()
  editing.value = null
  resetForm()
  showForm.value = true
}

function openEdit(user: ManagedUserView) {
  closeDetail()
  editing.value = user
  Object.assign(form, {
    username: user.username,
    displayName: user.displayName || '',
    email: user.email || '',
    password: '',
    platformAccessExpiresAt: localDateTime(user.platformAccessExpiresAt),
    role: uiRole(user.role),
    status: uiStatus(user.status),
    groupIds: [...user.groupIds]
  })
  originalRole.value = user.role
  resetPassword.value = ''
  showPassword.value = false
  formError.value = ''
  const assigned = user.subscription
  selectedPlanId.value = assigned?.planId || defaultPlanId()
  originalPlanId.value = assigned?.planId || ''
  showForm.value = true
}

async function save() {
  if (form.role === 'user' && !selectedPlanId.value) {
    formError.value = '请先创建或启用一个用户套餐'
    return
  }
  saving.value = true
  formError.value = ''
  try {
    if (editing.value) {
      await $fetch(`/api/admin/users/${editing.value.id}`, {
        method: 'PATCH',
        body: {
          username: form.username,
          displayName: form.displayName,
          email: form.email,
          role: form.role === 'user' ? 'user' : (originalRole.value === 'user' ? 'admin' : originalRole.value),
          status: form.status,
          platformAccessExpiresAt: form.platformAccessExpiresAt ? new Date(form.platformAccessExpiresAt).toISOString() : null,
          groupIds: form.groupIds,
          planId: form.role === 'user' && selectedPlanId.value !== originalPlanId.value ? selectedPlanId.value : undefined
        }
      })
      if (resetPassword.value) {
        await $fetch(`/api/admin/users/${editing.value.id}/reset-password`, { method: 'POST', body: { password: resetPassword.value } })
      }
      showToast('用户资料已保存', 'success')
    } else {
      await $fetch<{ user: HubUserView }>('/api/admin/users', { method: 'POST', body: { ...form, platformAccessExpiresAt: form.platformAccessExpiresAt ? new Date(form.platformAccessExpiresAt).toISOString() : null, planId: form.role === 'user' ? selectedPlanId.value : undefined } })
      showToast('用户已创建', 'success')
    }
    await Promise.all([refresh(), refreshGroups(), refreshPlans()])
    showForm.value = false
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    formError.value = failure.data?.message || failure.message || '保存用户失败'
    showToast(formError.value, 'error')
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!deletingUser.value || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/admin/users/${deletingUser.value.id}`, { method: 'DELETE' })
    showToast('用户已删除', 'success')
    deletingUser.value = null
    await Promise.all([refresh(), refreshGroups()])
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    showToast(failure.data?.message || failure.message || '删除用户失败', 'error')
  } finally {
    deleting.value = false
  }
}

async function openDetail(user: HubUserView) {
  detailUser.value = user
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  try {
    detail.value = await $fetch<UserDetailView>(`/api/admin/users/${user.id}`)
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    detailError.value = failure.data?.message || failure.message || '读取用户详情失败'
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  if (!detailLoading.value) {
    detailUser.value = null
    detail.value = null
    detailError.value = ''
  }
}

function resetFilters() {
  search.value = ''
  roleFilter.value = ''
  statusFilter.value = ''
  groupFilter.value = ''
}

function date(value: number | null) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
    : '从未登录'
}

function platformExpiryLabel(user: HubUserView) {
  if (!user.platformAccessExpiresAt) return '长期有效'
  return user.platformAccessExpiresAt <= Date.now() ? `已于 ${date(user.platformAccessExpiresAt)} 到期` : `有效至 ${date(user.platformAccessExpiresAt)}`
}

function roleLabel(value: string) {
  return roleLabels[value as UserRole] || value
}

function statusLabel(value: string) {
  return statusLabels[value as UserStatus] || value
}

function planIcon(index: number) {
  return [IconCoin, IconBraces, IconGauge][index % 3]
}

function statusTone(value: string) {
  return value === 'locked' ? 'disabled' : value
}

function keyStatusLabel(value: string) {
  return value === 'active' ? '启用' : value === 'disabled' ? '停用' : value
}

function recentTone(status: string, httpStatus: number | null) {
  return (httpStatus || 0) >= 400 || status === 'error' ? 'error' : 'success'
}

function recentStatus(status: string, httpStatus: number | null) {
  return httpStatus || status || '—'
}

watch(() => form.role, (role) => {
  if (role === 'user') form.groupIds = []
})

function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (showForm.value) closeForm()
  else if (detailUser.value && !detailLoading.value) closeDetail()
}

onMounted(() => document.addEventListener('keydown', handleEscape))
onBeforeUnmount(() => document.removeEventListener('keydown', handleEscape))
</script>

<template>
  <div class="admin-page users-page">
    <header class="admin-page__header users-page__header">
      <div>
        <span class="admin-kicker">IDENTITIES</span>
        <h1>用户管理</h1>
        <p>管理登录账户、角色、状态与用户套餐。普通用户固定使用默认分组。</p>
      </div>
      <AppButton variant="primary" class="users-create-button" @click="openCreate">
        <IconPlus :size="16" :stroke-width="1.8" />创建用户
      </AppButton>
    </header>

    <section class="glass-panel users-toolbar" aria-label="用户筛选">
      <label class="users-search admin-search">
        <span class="sr-only">搜索用户名、姓名或邮箱</span>
        <IconSearch :size="16" :stroke-width="1.8" aria-hidden="true" />
        <input v-model="search" type="search" placeholder="搜索用户名、姓名或邮箱">
      </label>
      <AppFilterSelect v-model="roleFilter" label="筛选角色" :options="roleFilterOptions" />
      <AppFilterSelect v-model="statusFilter" label="筛选状态" :options="statusFilterOptions" />
      <span class="users-filter-control users-group-filter"><AppFilterSelect v-model="groupFilter" label="筛选分组" :options="groupFilterOptions" /></span>
      <span class="users-count">{{ filtered.length }} / {{ data?.users.length || 0 }} 个用户</span>
      <button class="icon-button users-reset-button" type="button" title="清除筛选" aria-label="清除筛选" @click="resetFilters">
        <IconRefresh :size="16" :stroke-width="1.8" />
      </button>
    </section>

    <section class="glass-panel users-table-panel" aria-label="用户列表">
      <div v-if="usersPending" class="users-empty users-empty--loading"><span class="users-skeleton users-skeleton--wide" /><span class="users-skeleton" /><span class="users-skeleton" /></div>
      <div v-else-if="usersError" class="users-empty users-empty--error"><IconShieldCheck :size="22" /><p>用户列表读取失败</p><small>{{ usersError.message }}</small><AppButton size="small" @click="refresh()">重新加载</AppButton></div>
      <template v-else>
        <table v-if="filtered.length" class="admin-table users-table">
          <thead><tr><th>用户</th><th>角色 / 状态</th><th>分组</th><th>套餐</th><th>Key</th><th>最后登录</th><th aria-label="操作" /></tr></thead>
          <tbody>
            <tr v-for="user in filtered" :key="user.id">
              <td>
                <div class="users-identity-cell">
                  <span class="users-user-glyph"><IconUser :size="16" :stroke-width="1.7" /></span>
                  <div class="users-identity-copy"><strong>{{ user.displayName || user.username }}</strong><code>{{ user.username }}</code><small>{{ user.email || '未设置邮箱' }}</small></div>
                </div>
              </td>
              <td data-label="角色 / 状态"><div class="users-role-cell"><strong>{{ roleLabel(user.role) }}</strong><span class="status-label" :data-status="statusTone(user.status)"><i />{{ statusLabel(user.status) }}</span></div></td>
              <td data-label="分组"><span class="users-text-cell">{{ user.groupNames.join('、') || '未分组' }}</span></td>
              <td data-label="套餐"><span class="users-plan-cell"><strong>{{ user.subscription?.planName || (user.role === 'user' ? '默认不限量' : '—') }}</strong><small :data-expired="Boolean(user.platformAccessExpiresAt && user.platformAccessExpiresAt <= Date.now())">{{ platformExpiryLabel(user) }}</small></span></td>
              <td data-label="Key"><NuxtLink :to="{ path: '/admin/keys', query: { owner: user.id } }" class="users-key-link"><IconKey :size="14" :stroke-width="1.8" />{{ user.keyCount }}</NuxtLink></td>
              <td data-label="最后登录"><span class="users-date">{{ date(user.lastLoginAt) }}</span></td>
              <td data-label="操作"><div class="table-actions users-table-actions"><button class="icon-button" type="button" title="用户详情" aria-label="用户详情" @click="openDetail(user)"><IconChartBar :size="16" :stroke-width="1.8" /></button><button class="icon-button" type="button" title="重置密码" aria-label="重置密码" @click="openEdit(user)"><IconKey :size="16" :stroke-width="1.8" /></button><button class="icon-button" type="button" title="编辑用户" aria-label="编辑用户" @click="openEdit(user)"><IconEdit :size="16" :stroke-width="1.8" /></button><button class="icon-button danger" type="button" title="删除用户" aria-label="删除用户" :disabled="user.keyCount > 0" @click="deletingUser = user"><IconTrash :size="16" :stroke-width="1.8" /></button></div></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="users-empty"><IconSearch :size="22" :stroke-width="1.7" /><p>没有匹配的用户</p><small>尝试清除筛选条件或调整搜索内容</small><AppButton size="small" @click="resetFilters">清除筛选</AppButton></div>
      </template>
    </section>

    <Transition name="hub-layer">
      <div v-if="detailUser" class="log-drawer-backdrop users-layer-backdrop" role="presentation" @click.self="closeDetail">
        <aside class="log-drawer users-detail-drawer hub-layer-panel hub-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="users-detail-title">
          <header class="users-drawer-header">
            <div><span class="users-layer-kicker">IDENTITY PROFILE</span><div class="users-drawer-title"><strong>用户详情</strong><code>@{{ detailIdentity?.username }}</code></div></div>
            <button class="icon-button" type="button" title="关闭用户详情" aria-label="关闭用户详情" @click="closeDetail"><IconX :size="18" :stroke-width="1.8" /></button>
          </header>
          <section class="users-drawer-identity">
            <span class="users-profile-avatar"><IconUser :size="20" :stroke-width="1.7" /></span>
            <div class="users-drawer-identity-copy"><h2 id="users-detail-title">{{ detailIdentity?.displayName || detailIdentity?.username }}</h2><div class="users-identity-badges"><code>{{ roleLabel(detailIdentity?.role || '') }}</code><span class="status-label" :data-status="statusTone(detailIdentity?.status || '')"><i />{{ statusLabel(detailIdentity?.status || '') }}</span></div></div>
            <div class="users-identity-context"><span><IconUsers :size="13" :stroke-width="1.7" /><b>{{ detailIdentity?.groupNames.join('、') || '未分组' }}</b></span><span><IconActivity :size="13" :stroke-width="1.7" /><b>{{ date(detailIdentity?.lastLoginAt || null) }}</b></span></div>
          </section>
          <section class="users-drawer-metrics" aria-label="用户用量">
            <article><div class="users-metric-label"><span class="users-metric-icon"><IconActivity :size="13" :stroke-width="1.7" /></span><span>请求量</span></div><strong>{{ detailLoading ? '—' : detail?.usage.requests.toLocaleString() }}</strong><small>累计请求</small></article>
            <article><div class="users-metric-label"><span class="users-metric-icon"><IconBraces :size="13" :stroke-width="1.7" /></span><span>Token</span></div><strong>{{ detailLoading ? '—' : formatTokenCount(detail?.usage.tokens || 0) }}</strong><small>输入与输出</small></article>
            <article><div class="users-metric-label"><span class="users-metric-icon"><IconCoin :size="13" :stroke-width="1.7" /></span><span>成本</span></div><strong>{{ detailLoading ? '—' : `$${(detail?.usage.cost || 0).toFixed(4)}` }}</strong><small>累计结算</small></article>
          </section>
          <div v-if="detailLoading" class="users-drawer-loading"><span class="users-skeleton users-skeleton--wide" /><span class="users-skeleton" /><span class="users-skeleton" /></div>
          <div v-else-if="detailError" class="users-drawer-error"><IconShieldCheck :size="19" :stroke-width="1.7" /><strong>详情读取失败</strong><p>{{ detailError }}</p><AppButton size="small" @click="detailUser && openDetail(detailUser)">重新读取</AppButton></div>
          <template v-else-if="detail">
            <section class="users-drawer-section"><header class="users-section-heading"><div><span class="users-section-icon"><IconKey :size="15" :stroke-width="1.7" /></span><div><h3>Hub Keys</h3><small>用户访问凭据</small></div></div><span>{{ detail.keys.length }} 个</span></header><div class="users-credential-list"><div v-for="key in detail.keys" :key="key.id" class="users-credential-row"><div><strong>{{ key.name }}</strong><code>{{ key.maskedKey }}</code><small>{{ key.lastUsedAt ? `最近使用 ${date(key.lastUsedAt)}` : '尚未使用' }}</small></div><span class="status-label" :data-status="statusTone(key.status)"><i />{{ keyStatusLabel(key.status) }}</span><button class="icon-button" type="button" title="复制完整 Key" aria-label="复制完整 Key" :disabled="copyingUserKeyId === key.id" @click="copyUserKey(key)"><IconCopy :size="15" :stroke-width="1.7" /></button></div><div v-if="!detail.keys.length" class="users-inline-empty">尚未创建 Hub Key</div></div></section>
            <section class="users-drawer-section users-activity-section"><header class="users-section-heading"><div><span class="users-section-icon"><IconChartBar :size="15" :stroke-width="1.7" /></span><div><h3>最近活动</h3><small>最新请求记录</small></div></div><span>{{ detail.recent.length }} 条</span></header><div class="users-activity-list"><div v-for="item in detail.recent" :key="item.id" class="users-activity-row" :data-tone="recentTone(item.status, item.httpStatus)"><code>{{ item.requestId }}</code><span>{{ item.model || '—' }}</span><strong>{{ recentStatus(item.status, item.httpStatus) }}</strong><small>{{ date(item.createdAt) }}</small></div><div v-if="!detail.recent.length" class="users-inline-empty">尚无请求记录</div></div></section>
          </template>
        </aside>
      </div>
    </Transition>

    <Transition name="hub-layer">
      <div v-if="showForm" class="admin-modal-backdrop users-layer-backdrop users-form-backdrop" role="presentation" @click.self="closeForm">
        <section class="admin-modal admin-modal--wide users-modal hub-layer-panel" role="dialog" aria-modal="true" aria-labelledby="users-form-title">
          <header class="users-modal-header"><div class="users-modal-heading"><span class="users-modal-title-icon"><component :is="editing ? IconEdit : IconUser" :size="18" :stroke-width="1.7" /></span><div><span class="users-layer-kicker">IDENTITY</span><h2 id="users-form-title">{{ editing ? '编辑用户' : '创建用户' }}</h2><p>{{ editing ? '更新账户资料与访问策略' : '配置登录身份与初始访问权限' }}</p></div></div><button class="icon-button" type="button" title="关闭用户表单" aria-label="关闭用户表单" @click="closeForm"><IconX :size="18" :stroke-width="1.8" /></button></header>
          <form class="users-form" @submit.prevent="save">
            <div class="users-form-layout">
              <section class="users-form-main">
                <header class="users-form-section-heading"><div><span>ACCOUNT</span><h3>账户资料</h3></div><small>登录凭据与基本信息</small></header>
                <div class="users-form-grid">
                  <label class="users-form-field"><span>用户名 <b class="users-required">*</b></span><input v-model="form.username" autocomplete="off" required><small /></label>
                  <label class="users-form-field"><span>显示名称</span><input v-model="form.displayName"><small /></label>
                </div>
                <div class="users-form-grid">
                  <label class="users-form-field"><span>邮箱</span><input v-model="form.email" type="email"><small /></label>
                  <label class="users-form-field"><span>{{ editing ? '重置密码' : '初始密码' }} <b v-if="!editing" class="users-required">*</b></span><span class="users-password-shell"><input v-if="editing" v-model="resetPassword" :type="showPassword ? 'text' : 'password'" minlength="8" autocomplete="new-password" placeholder="留空表示不修改"><input v-else v-model="form.password" :type="showPassword ? 'text' : 'password'" required minlength="8" autocomplete="new-password"><button class="icon-button users-password-toggle" type="button" :title="showPassword ? '隐藏密码' : '显示密码'" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><IconEyeOff v-if="showPassword" :size="16" :stroke-width="1.8" /><IconEye v-else :size="16" :stroke-width="1.8" /></button></span><small>{{ editing ? '重置后该用户下次登录必须修改密码' : '至少 8 位字符；用户首次登录必须修改' }}</small></label>
                </div>
                <div class="form-grid form-grid--expiry users-platform-expiry"><label class="users-form-field"><span>平台套餐到期时间</span><input v-model="form.platformAccessExpiresAt" type="datetime-local"><small>到期后仅停用平台套餐，个人中转与专属号池不受影响</small></label><div class="expiry-presets"><span>从现在起</span><div><button v-for="days in [1, 7, 30]" :key="days" type="button" @click="setPlatformExpiry(days)">{{ days }} 天</button><button type="button" @click="form.platformAccessExpiresAt = ''">永久</button></div></div></div>
                <div class="users-role-controls">
                  <AppRadioGroup v-model="form.role" name="user-role" label="角色" legend="角色" :options="roleOptions" :columns="2" class="users-role-group" />
                  <label v-if="editing" class="users-form-field users-status-field"><span>状态</span><span class="switch users-status-switch"><input v-model="statusEnabled" type="checkbox" :aria-label="statusEnabled ? '停用用户' : '启用用户'"><span aria-hidden="true" /><em>{{ statusEnabled ? '启用' : '停用' }}</em></span><small>停用后将无法登录或使用 Hub Key</small></label>
                </div>
              </section>
              <aside class="users-access-panel">
                <header class="users-access-heading"><span class="users-access-icon"><IconShieldCheck :size="16" :stroke-width="1.7" /></span><div><span>ACCESS</span><h3>访问配置</h3><p>{{ form.role === 'user' ? '普通用户权限' : `${roleLabel(form.role)} 权限` }}</p></div><code>{{ form.role.toUpperCase() }}</code></header>
                <div class="users-access-choice-block"><header><span>Hub 分组</span><small>{{ form.role === 'user' ? '固定' : '可多选' }}</small></header>
                  <div v-if="form.role === 'user'" class="users-fixed-surface"><span class="users-fixed-icon"><IconUsers :size="14" :stroke-width="1.7" /></span><span class="users-fixed-copy"><strong>默认分组</strong><small>普通用户固定归属</small></span><span class="users-fixed-label">已固定</span></div>
                  <AppCheckboxGroup v-else v-model="form.groupIds" label="Hub 分组" :options="groupChoiceOptions" />
                  <div v-if="form.role !== 'user' && !activeGroups.length" class="users-inline-empty">没有可选的活动分组</div>
                </div>
                <div v-if="form.role === 'user'" class="users-access-choice-block"><header><span>用户套餐</span><small>单选</small></header><AppRadioGroup v-model="selectedPlanId" name="user-plan" label="用户套餐" :options="planChoiceOptions" compact /><div v-if="!activePlans.length" class="users-inline-empty">暂无可用套餐</div></div>
                <div class="users-access-note"><IconShieldCheck :size="14" :stroke-width="1.7" /><p>登录状态和分组策略将在保存后立即生效。</p></div>
              </aside>
            </div>
            <p v-if="formError" class="users-form-message">{{ formError }}</p>
            <footer class="users-modal-footer"><AppButton @click="closeForm">取消</AppButton><AppButton variant="primary" type="submit" :loading="saving" loading-label="保存中"><IconShieldCheck :size="15" :stroke-width="1.8" /><span>{{ editing ? '保存修改' : '保存用户' }}</span></AppButton></footer>
          </form>
        </section>
      </div>
    </Transition>

    <AppConfirmDialog :open="Boolean(deletingUser)" :busy="deleting" title="删除用户" :message="`确定删除用户“${deletingUser?.username || ''}”？该操作无法恢复。`" confirm-label="删除用户" @close="deletingUser = null" @confirm="remove" />
  </div>
</template>

<style scoped>
.users-page { width: min(100% - calc(var(--hub-page-gutter) * 2), var(--hub-content-max)); padding-top: 2.5rem; }
.users-page__header { min-height: 90px; margin-bottom: 1.5rem; align-items: flex-end; }
.users-page__header h1 { font-size: 2.2rem; }
.users-toolbar { position: relative; z-index: var(--hub-z-local-sticky); min-height: 4.2rem; margin-bottom: .75rem; padding: .75rem; overflow: visible; display: grid; grid-template-columns: minmax(17rem, 1.7fr) repeat(3, minmax(8.5rem, .72fr)) auto auto; align-items: center; gap: .65rem; }
.users-search { min-width: 0; width: 100%; }
.users-search input { width: 100%; min-height: 2.45rem; }
.users-filter-control { min-width: 0; width: 100%; }
.users-count { min-width: 6rem; color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .7rem; text-align: right; white-space: nowrap; }
.users-reset-button { width: 2.45rem; height: 2.45rem; }
.users-table-panel { overflow-x: auto; }
.users-table { min-width: 68rem; background: transparent; }
.users-table th { height: 2.9rem; padding-inline: 1rem; background: color-mix(in srgb, var(--hub-glass-strong) 35%, transparent); font-size: .7rem; }
.users-table td { min-height: 4.6rem; padding: .95rem 1rem; font-size: .76rem; }
.users-table tbody tr { transition: background-color var(--hub-duration-base) ease; }
.users-table tbody tr:hover { background: color-mix(in srgb, var(--hub-accent-soft) 70%, transparent); }
.users-identity-cell { min-width: 13rem; display: flex; align-items: center; gap: .75rem; }
.users-user-glyph { width: 2.25rem; height: 2.25rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-accent-line); border-radius: 6px; color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.users-identity-copy { min-width: 0; }
.users-identity-copy strong, .users-identity-copy code, .users-identity-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.users-identity-copy strong { color: var(--hub-text); font-size: .82rem; font-weight: var(--hub-weight-semibold); }
.users-identity-copy code { margin-top: .22rem; color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .74rem; }
.users-identity-copy small { margin-top: .2rem; color: var(--hub-text-faint); font-size: .68rem; }
.users-role-cell { display: flex; align-items: center; flex-wrap: wrap; gap: .45rem; }
.users-role-cell > strong { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .72rem; font-weight: var(--hub-weight-medium); }
.users-page .status-label { min-height: 0; padding: 0; border: 0; gap: .35rem; color: var(--hub-text-muted); background: transparent; font-size: .7rem; font-weight: var(--hub-weight-regular); }
.users-page .status-label i { width: .4rem; height: .4rem; border-radius: 50%; background: var(--hub-success); box-shadow: 0 0 0 3px var(--hub-success-soft); }
.users-page .status-label[data-status='disabled'] { color: var(--hub-text-faint); border-color: transparent; background: transparent; }
.users-page .status-label[data-status='locked'] { color: var(--hub-warning); border-color: transparent; background: transparent; }
.users-page .status-label[data-status='disabled'] i { background: var(--hub-text-disabled); box-shadow: none; }
.users-page .status-label[data-status='locked'] i { background: var(--hub-warning); box-shadow: 0 0 0 3px var(--hub-warning-soft); }
.users-text-cell, .users-date { color: var(--hub-text-muted); white-space: nowrap; }
.users-plan-cell { display:grid; gap:.18rem; white-space:nowrap; }
.users-plan-cell strong { color:var(--hub-text-muted); font-size:.74rem; font-weight:var(--hub-weight-medium); }
.users-plan-cell small { color:var(--hub-text-faint); font-size:.66rem; }
.users-plan-cell small[data-expired='true'] { color:var(--hub-danger); }
.users-key-link { display: inline-flex; align-items: center; gap: .35rem; color: var(--hub-accent-text); font-family: var(--hub-font-mono); font-size: .74rem; font-weight: var(--hub-weight-medium); }
.users-key-link:hover { color: var(--hub-accent-bright); }
.users-table-actions { justify-content: flex-end; gap: .35rem; }
.users-empty { min-height: 14rem; padding: 2rem; display: grid; place-items: center; align-content: center; gap: .55rem; color: var(--hub-text-faint); text-align: center; }
.users-empty p { color: var(--hub-text-muted); font-size: .8rem; }
.users-empty small { max-width: 42rem; color: var(--hub-text-faint); font-size: .7rem; }
.users-empty--error { color: var(--hub-danger); }
.users-empty--error p { color: var(--hub-danger); }
.users-empty .button { margin-top: .35rem; }
.users-skeleton { width: 64%; height: 2.75rem; border-radius: var(--hub-radius-md); background: var(--hub-skeleton-strong); animation: users-pulse 1.4s ease-in-out infinite; }
.users-skeleton--wide { width: 86%; height: 3.2rem; }
.users-empty--loading { place-items: stretch; }
.users-drawer-loading { padding: 1.35rem 1.4rem; display: grid; gap: .75rem; }
.users-drawer-loading .users-skeleton { width: 100%; }
@keyframes users-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes users-panel-enter { from { opacity: 0; transform: translateY(.65rem); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: no-preference) {
  .users-page__header, .users-toolbar, .users-table-panel { opacity: 0; animation: users-panel-enter 520ms var(--hub-motion-ease) forwards; }
  .users-toolbar { animation-delay: 70ms; }
  .users-table-panel { animation-delay: 130ms; }
}

.users-layer-backdrop { padding: 0; place-items: stretch end; }
.users-detail-drawer { width: min(46rem, 58vw); height: 100dvh; overflow-y: auto; border-left: 1px solid var(--hub-line-strong); background: linear-gradient(180deg, color-mix(in srgb, var(--hub-solid-surface-strong) 94%, var(--hub-accent-soft)), var(--hub-solid-surface-strong)); box-shadow: var(--hub-panel-shadow); }
.users-drawer-header { position: sticky; top: 0; z-index: var(--hub-z-local-sticky); min-height: 5.4rem; padding: 0 1.4rem; border-bottom: 1px solid var(--hub-line); display: flex; align-items: center; justify-content: space-between; gap: 1rem; background: color-mix(in srgb, var(--hub-solid-surface-strong) 82%, transparent); backdrop-filter: var(--hub-blur-panel); }
.users-layer-kicker { display: block; margin-bottom: .3rem; color: var(--hub-accent-text); font-family: var(--hub-font-mono); font-size: .66rem; font-weight: var(--hub-weight-medium); }
.users-drawer-title { display: flex; align-items: baseline; gap: .65rem; }
.users-drawer-title strong { color: var(--hub-text); font-size: .98rem; font-weight: var(--hub-weight-semibold); }
.users-drawer-title code { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .7rem; }
.users-drawer-identity { min-height: 9rem; padding: 1.35rem 1.4rem 1.45rem; border-bottom: 1px solid var(--hub-line); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0 1rem; background: linear-gradient(110deg, var(--hub-accent-soft), transparent 54%); }
.users-profile-avatar { width: 3.25rem; height: 3.25rem; display: grid; place-items: center; grid-row: 1 / span 2; border: 1px solid var(--hub-accent-line); border-radius: 8px; color: var(--hub-accent-text); background: var(--hub-accent-soft); box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow); }
.users-drawer-identity-copy { min-width: 0; }
.users-drawer-identity h2 { margin: 0; color: var(--hub-text); font-size: 1.35rem; font-weight: var(--hub-weight-semibold); }
.users-identity-badges { display: flex; align-items: center; gap: .65rem; margin-top: .45rem; }
.users-identity-badges > code { padding: .25rem .4rem; border: 1px solid var(--hub-accent-line); border-radius: 4px; color: var(--hub-accent-text); background: var(--hub-accent-soft); font-family: var(--hub-font-mono); font-size: .62rem; }
.users-identity-context { min-width: 0; grid-column: 2; display: flex; align-items: center; flex-wrap: wrap; gap: 1.1rem; margin-top: .85rem; }
.users-identity-context span { min-width: 0; display: inline-flex; align-items: center; gap: .4rem; color: var(--hub-text-faint); font-size: .66rem; }
.users-identity-context b { overflow: hidden; color: var(--hub-text-muted); font-weight: var(--hub-weight-regular); text-overflow: ellipsis; white-space: nowrap; }
.users-drawer-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: .85rem; border-bottom: 1px solid var(--hub-line); background: color-mix(in srgb, var(--hub-bg) 18%, transparent); }
.users-drawer-metrics article { min-width: 0; padding: .85rem 1rem; }
.users-drawer-metrics article + article { border-left: 1px solid var(--hub-line); }
.users-metric-label { display: flex; align-items: center; gap: .45rem; color: var(--hub-text-muted); font-size: .68rem; }
.users-metric-icon { width: 1.5rem; height: 1.5rem; display: grid; place-items: center; border: 1px solid var(--hub-line); border-radius: 5px; color: var(--hub-text-faint); background: var(--hub-glass-strong); }
.users-drawer-metrics strong { display: block; margin-top: .65rem; overflow: hidden; color: var(--hub-text); font-family: var(--hub-font-mono); font-size: 1.65rem; font-weight: var(--hub-weight-medium); line-height: 1; text-overflow: ellipsis; white-space: nowrap; }
.users-drawer-metrics small { display: block; margin-top: .42rem; color: var(--hub-text-faint); font-size: .6rem; }
.users-drawer-section { padding: 1.35rem 1.4rem; border-bottom: 1px solid var(--hub-line); }
.users-drawer-section:last-child { border-bottom: 0; }
.users-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .85rem; }
.users-section-heading > div { display: flex; align-items: center; gap: .65rem; }
.users-section-heading h3 { margin: 0; color: var(--hub-text); font-size: .82rem; font-weight: var(--hub-weight-semibold); }
.users-section-heading small { display: block; margin-top: .18rem; color: var(--hub-text-faint); font-size: .6rem; }
.users-section-heading > span { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .68rem; }
.users-section-icon { width: 2rem; height: 2rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-accent-line); border-radius: 6px; color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.users-credential-list, .users-activity-list { display: grid; }
.users-credential-row { min-height: 4.25rem; padding: 0 .55rem; border-top: 1px solid var(--hub-line-row); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 1rem; transition: background-color var(--hub-duration-fast) ease; }
.users-credential-row:first-child { border-top: 0; }
.users-credential-row:hover { background: var(--hub-accent-soft); }
.users-credential-row > div { min-width: 0; display: grid; gap: .28rem; }
.users-credential-row strong { color: var(--hub-text); font-size: .78rem; font-weight: var(--hub-weight-semibold); }
.users-credential-row code { overflow: hidden; color: var(--hub-text-muted); font-family: var(--hub-font-mono); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
.users-credential-row small { color: var(--hub-text-faint); font-size: .6rem; }
.users-activity-row { position: relative; min-height: 3.35rem; padding: 0 .55rem 0 .8rem; border-top: 1px solid var(--hub-line-row); border-radius: 5px; display: grid; grid-template-columns: minmax(12rem, 1fr) 6.75rem 3rem 7.5rem; align-items: center; gap: .75rem; font-size: .7rem; transition: background-color var(--hub-duration-fast) ease; }
.users-activity-row:first-child { border-top: 0; }
.users-activity-row:hover { background: var(--hub-accent-soft); }
.users-activity-row::before { content: ''; position: absolute; left: .15rem; width: 2px; height: 1rem; border-radius: 2px; background: var(--hub-success); opacity: .62; }
.users-activity-row[data-tone='error']::before { background: var(--hub-danger); }
.users-activity-row code, .users-activity-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.users-activity-row code { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .68rem; }
.users-activity-row span { color: var(--hub-text-muted); }
.users-activity-row strong { color: var(--hub-success); font-family: var(--hub-font-mono); font-size: .7rem; font-weight: var(--hub-weight-medium); }
.users-activity-row[data-tone='error'] strong { color: var(--hub-danger); }
.users-activity-row small { color: var(--hub-text-faint); font-size: .65rem; text-align: right; }
.users-inline-empty { padding: 1.5rem 0; color: var(--hub-text-faint); font-size: .74rem; text-align: center; }
.users-drawer-error { padding: 2rem 1.4rem; display: grid; justify-items: center; gap: .55rem; color: var(--hub-danger); text-align: center; }
.users-drawer-error strong { color: var(--hub-text); font-size: .82rem; }
.users-drawer-error p { max-width: 34rem; color: var(--hub-text-muted); font-size: .72rem; }

.users-form-backdrop { padding: 1.5rem; place-items: center; }
.users-modal { width: min(68rem, 100%); height: min(44rem, calc(100dvh - 3rem)); overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.users-modal-header { position: sticky; top: 0; z-index: var(--hub-z-local-raised); min-height: 6.2rem; padding: 0 1.4rem; border-bottom: 1px solid var(--hub-line); display: flex; align-items: center; justify-content: space-between; gap: 1rem; background: color-mix(in srgb, var(--hub-solid-surface) 78%, transparent); backdrop-filter: var(--hub-blur-panel); }
.users-modal-heading { min-width: 0; display: flex; align-items: center; gap: .85rem; }
.users-modal-title-icon { width: 2.65rem; height: 2.65rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-accent-line); border-radius: 7px; color: var(--hub-accent-text); background: var(--hub-accent-soft); box-shadow: var(--hub-panel-highlight); }
.users-modal-heading h2 { margin: 0; color: var(--hub-text); font-size: 1.08rem; font-weight: var(--hub-weight-semibold); }
.users-modal-heading p { margin: .25rem 0 0; color: var(--hub-text-faint); font-size: .66rem; }
.users-form { min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) auto auto; overflow: hidden; padding: 0; }
.users-form-layout { min-height: 0; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(23rem, .8fr); overflow: hidden; }
.users-form-main, .users-access-panel { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; }
.users-form-main { min-width: 0; padding: 1.35rem 1.4rem 1.15rem; }
.users-access-panel { min-width: 0; display: flex; flex-direction: column; padding: 1.35rem 1.25rem; border-left: 1px solid var(--hub-line); background: linear-gradient(180deg, var(--hub-accent-soft), color-mix(in srgb, var(--hub-glass) 70%, transparent)); }
.users-form-section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-bottom: 1.15rem; padding-bottom: .75rem; border-bottom: 1px solid var(--hub-line); }
.users-form-section-heading span, .users-access-heading > div > span { color: var(--hub-accent-text); font-family: var(--hub-font-mono); font-size: .6rem; }
.users-form-section-heading h3, .users-access-heading h3 { margin: .2rem 0 0; color: var(--hub-text); font-size: .86rem; font-weight: var(--hub-weight-semibold); }
.users-form-section-heading small { color: var(--hub-text-faint); font-size: .62rem; }
.users-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; margin-bottom: .75rem; }
.users-form-field { min-width: 0; display: grid; gap: .45rem; color: var(--hub-text-muted); font-size: .74rem; font-weight: var(--hub-weight-medium); }
.users-form-field input:not([type='checkbox']), .users-form-field :deep(.app-select select) { min-height: 2.45rem; padding-inline: .7rem; border-radius: 7px; font-size: .78rem; }
.users-form-field > small { min-height: .9rem; color: var(--hub-text-faint); font-size: .66rem; font-weight: var(--hub-weight-regular); }
.users-required { color: var(--hub-danger); }
.users-password-shell { position: relative; }
.users-password-shell input { width: 100%; padding-left: .7rem; padding-right: 2.8rem; }
.users-password-toggle { position: absolute; top: 50%; right: .35rem; width: 2rem; height: 2rem; border: 0; color: var(--hub-text-faint); background: transparent; box-shadow: none; transform: translateY(-50%); }
.users-password-toggle:hover { border: 0; color: var(--hub-accent-text); background: transparent; }
.users-role-controls { display: grid; gap: 1rem; }
.users-status-field { width: min(16rem, 100%); }
.users-status-switch { min-height: 2.45rem; width: max-content; padding: .35rem .65rem .35rem .45rem; border: 1px solid var(--hub-line); border-radius: 7px; background: color-mix(in srgb, var(--hub-glass) 50%, transparent); }
.users-status-switch > span { width: 2.15rem; height: 1.2rem; padding: .15rem; border: 1px solid var(--hub-line-strong); border-radius: 999px; background: var(--hub-skeleton-strong); transition: background-color var(--hub-duration-fast) ease, border-color var(--hub-duration-fast) ease; }
.users-status-switch > span::after { width: .85rem; height: .85rem; background: var(--hub-solid-surface); transition: transform var(--hub-duration-fast) ease; }
.users-status-switch input:checked + span { border-color: var(--hub-success); background: var(--hub-success); }
.users-status-switch input:checked + span::after { transform: translateX(.95rem); }
.users-status-switch em { color: var(--hub-text-muted); font-size: .7rem; font-style: normal; font-weight: var(--hub-weight-medium); }
.users-status-switch:has(input:focus-visible) { outline: 2px solid var(--hub-focus-ring); outline-offset: 2px; }
.users-access-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .65rem; margin-bottom: 1rem; padding-bottom: .8rem; border-bottom: 1px solid var(--hub-line); }
.users-access-heading p { margin: .25rem 0 0; color: var(--hub-text-faint); font-size: .62rem; }
.users-access-heading > code { padding: .25rem .38rem; border: 1px solid var(--hub-line); border-radius: 4px; color: var(--hub-text-muted); font-family: var(--hub-font-mono); font-size: .58rem; }
.users-access-icon { width: 2.1rem; height: 2.1rem; display: grid; place-items: center; border: 1px solid var(--hub-accent-line); border-radius: 6px; color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.users-access-choice-block + .users-access-choice-block { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--hub-line); }
.users-access-choice-block > header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .55rem; }
.users-access-choice-block > header span { color: var(--hub-text-muted); font-size: .7rem; font-weight: var(--hub-weight-medium); }
.users-access-choice-block > header small { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .56rem; }
.users-fixed-surface { min-width: 0; min-height: 2.85rem; padding: .42rem .6rem; border: 1px solid var(--hub-line); border-radius: 6px; display: flex; align-items: center; gap: .58rem; color: var(--hub-text-muted); background: color-mix(in srgb, var(--hub-glass) 50%, transparent); box-shadow: var(--hub-panel-highlight); }
.users-fixed-icon { width: 1.8rem; height: 1.8rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-line); border-radius: 5px; color: var(--hub-text-faint); background: var(--hub-glass-strong); }
.users-fixed-copy { min-width: 0; flex: 1; }
.users-fixed-copy strong, .users-fixed-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.users-fixed-copy strong { color: var(--hub-text); font-size: .68rem; font-weight: var(--hub-weight-medium); }
.users-fixed-copy small { margin-top: .18rem; color: var(--hub-text-faint); font-size: .56rem; }
.users-fixed-label { color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .56rem; }
.users-access-note { display: flex; align-items: flex-start; gap: .5rem; margin-top: auto; padding-top: .85rem; border-top: 1px solid var(--hub-line); color: var(--hub-text-faint); }
.users-access-note svg { flex: 0 0 auto; color: var(--hub-accent-text); }
.users-access-note p { margin: 0; font-size: .62rem; line-height: 1.5; }
.users-form-message { margin: .85rem 1.4rem 0; padding: .7rem .8rem; border: 1px solid var(--hub-danger-line); border-radius: 6px; color: var(--hub-danger); background: var(--hub-danger-soft); font-size: .72rem; }
.users-modal-footer { z-index: var(--hub-z-local-raised); margin-top: 1rem; padding: .9rem 1.4rem; border-top: 1px solid var(--hub-line); display: flex; justify-content: flex-end; gap: .6rem; background: color-mix(in srgb, var(--hub-solid-surface) 84%, transparent); box-shadow: var(--hub-panel-shadow); backdrop-filter: var(--hub-blur-panel); }

@media (max-width: 1180px) {
  .users-toolbar { grid-template-columns: minmax(16rem, 1fr) repeat(2, minmax(8.5rem, .55fr)) auto; }
  .users-group-filter { grid-column: 2; }
  .users-count { grid-column: 3; }
}
@media (max-width: 960px) {
  .users-detail-drawer { width: min(44rem, 84vw); }
}
@media (max-width: 820px) {
  .users-modal { height: calc(100dvh - 3rem); }
  .users-form { display: block; overflow-y: auto; }
  .users-form-layout { display: block; overflow: visible; }
  .users-form-main, .users-access-panel { overflow: visible; }
  .users-access-panel { min-height: 18rem; border-top: 1px solid var(--hub-line); border-left: 0; }
  .users-modal-footer { position: sticky; bottom: 0; margin-top: 0; }
}
@media (max-width: 720px) {
  .users-page { padding-top: 1.75rem; }
  .users-page__header { align-items: stretch; flex-direction: column; gap: 1rem; }
  .users-page__header h1 { font-size: 1.85rem; }
  .users-create-button { align-self: flex-start; }
  .users-toolbar { grid-template-columns: 1fr 1fr; }
  .users-search { grid-column: 1 / -1; }
  .users-group-filter { grid-column: auto !important; }
  .users-count { grid-column: 1; text-align: left; }
  .users-reset-button { justify-self: end; }
  .users-table-panel { overflow: visible; }
  .users-table { min-width: 0; }
  .users-table, .users-table tbody, .users-table tr, .users-table td { display: block; width: 100%; }
  .users-table thead { display: none; }
  .users-table tr { padding: 1rem; }
  .users-table td { min-height: 0; display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); align-items: center; gap: .75rem; padding: .55rem 0; border: 0; }
  .users-table td::before { content: attr(data-label); color: var(--hub-text-faint); font-size: .68rem; }
  .users-table td:first-child { display: block; padding-top: 0; padding-bottom: .9rem; border-bottom: 1px solid var(--hub-line); }
  .users-table td:first-child::before { display: none; }
  .users-table td:last-child { display: flex; justify-content: flex-end; margin-top: .35rem; padding-top: .8rem; border-top: 1px solid var(--hub-line); }
  .users-table td:last-child::before { margin-right: auto; }
  .users-table-actions { justify-content: flex-start; }
  .users-detail-drawer { width: 100%; }
  .users-form-grid { grid-template-columns: 1fr; gap: .85rem; }
  .users-identity-context { align-items: flex-start; flex-direction: column; gap: .45rem; }
  .users-activity-row { grid-template-columns: minmax(0, 1fr) auto auto; padding: .7rem .55rem .7rem .8rem; }
  .users-activity-row code { grid-column: 1 / -1; }
}
@media (max-width: 480px) {
  .users-toolbar { grid-template-columns: 1fr; padding-bottom: 3.8rem; position: relative; }
  .users-search, .users-group-filter, .users-count { grid-column: auto !important; }
  .users-reset-button { position: absolute; right: .75rem; bottom: .75rem; }
  .users-table td { grid-template-columns: 5.2rem minmax(0, 1fr); }
  .users-form-backdrop { padding: .65rem; }
  .users-modal { height: calc(100dvh - 1.3rem); }
  .users-modal-header { min-height: 4.5rem; padding-inline: 1rem; }
  .users-form-main, .users-access-panel { padding: 1rem; }
  .users-modal-footer { padding: .85rem 1rem; }
  .users-modal-footer .button--primary { min-width: 8.5rem; }
  .users-drawer-header { min-height: 4.5rem; padding-inline: 1rem; }
  .users-drawer-section { padding: 1rem; }
  .users-drawer-identity { padding-inline: 1rem; }
  .users-drawer-metrics { padding: .55rem; }
  .users-drawer-metrics article { padding: .85rem .35rem; }
  .users-drawer-metrics strong { font-size: 1.05rem; }
  .users-metric-label { gap: .3rem; font-size: .62rem; }
  .users-metric-icon { width: 1.35rem; height: 1.35rem; }
  .users-credential-row { min-height: 4.2rem; }
  .users-activity-row { grid-template-columns: minmax(0, 1fr) auto; }
  .users-activity-row strong { text-align: right; }
  .users-activity-row small { grid-column: 1 / -1; text-align: left; }
}
</style>
