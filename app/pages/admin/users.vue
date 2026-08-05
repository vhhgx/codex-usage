<script setup lang="ts">
import { IconChartBar, IconEdit, IconKey, IconLock, IconPlus, IconSearch, IconTrash, IconUser, IconX } from '@tabler/icons-vue'
import type { HubGroupView, HubUserView, UserRole, UserStatus } from '#shared/types/access-control'
import type { AdminSessionView } from '#shared/types/hub'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '用户管理 | Zephyr Hub' })

interface ManagedUserView extends HubUserView {
  subscription: null | { planId: string; planName: string; status: string }
}
interface PlanData { plans: Array<{ id: string; name: string; status: string }> }

const { data, refresh } = await useFetch<{ users: ManagedUserView[] }>('/api/admin/users')
const { data: groupData, refresh: refreshGroups } = await useFetch<{ groups: HubGroupView[] }>('/api/admin/groups')
const { data: planData, refresh: refreshPlans } = await useFetch<PlanData>('/api/admin/plans')
const search = ref('')
const roleFilter = ref('')
const statusFilter = ref('')
const groupFilter = ref('')
const editing = ref<ManagedUserView | null>(null)
const showForm = ref(false)
const saving = ref(false)
const error = ref('')
const resetPassword = ref('')
const resetPasswordEnabled = ref(false)
const detail = ref<any>(null)
const deletingUser = ref<HubUserView | null>(null)
const selectedPlanId = ref('00000000-0000-4000-8000-000000000002')
const originalPlanId = ref('')
const session = useState<AdminSessionView | null>('auth-session', () => null)
const form = reactive({ username: '', displayName: '', email: '', password: '', role: 'user' as UserRole, status: 'active' as UserStatus, groupIds: [] as string[] })

const filtered = computed(() => (data.value?.users || []).filter(user => {
  const needle = search.value.trim().toLowerCase()
  return (!needle || `${user.username} ${user.displayName || ''} ${user.email || ''}`.toLowerCase().includes(needle))
    && (!roleFilter.value || user.role === roleFilter.value)
    && (!statusFilter.value || user.status === statusFilter.value)
    && (!groupFilter.value || user.groupIds.includes(groupFilter.value))
}))

function resetForm() {
  Object.assign(form, { username: '', displayName: '', email: '', password: '', role: 'user', status: 'active', groupIds: [] })
  resetPassword.value = ''
  resetPasswordEnabled.value = false
  error.value = ''
  selectedPlanId.value = '00000000-0000-4000-8000-000000000002'
  originalPlanId.value = ''
}
function openCreate() { editing.value = null; resetForm(); showForm.value = true }
function openEdit(user: ManagedUserView) {
  editing.value = user
  Object.assign(form, { username: user.username, displayName: user.displayName || '', email: user.email || '', password: '', role: user.role, status: user.status, groupIds: [...user.groupIds] })
  resetPassword.value = ''
  resetPasswordEnabled.value = false
  error.value = ''
  const assigned = user.subscription
  selectedPlanId.value = assigned?.planId || '00000000-0000-4000-8000-000000000002'
  originalPlanId.value = assigned?.planId || ''
  showForm.value = true
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    if (editing.value) {
      await $fetch(`/api/admin/users/${editing.value.id}`, { method: 'PATCH', body: { username: form.username, displayName: form.displayName, email: form.email, role: form.role, status: form.status, groupIds: form.groupIds } })
      if (resetPasswordEnabled.value && resetPassword.value) await $fetch(`/api/admin/users/${editing.value.id}/reset-password`, { method: 'POST', body: { password: resetPassword.value } })
      if (form.role === 'user' && selectedPlanId.value && selectedPlanId.value !== originalPlanId.value) await $fetch('/api/admin/plans/assign', { method: 'POST', body: { userId: editing.value.id, planId: selectedPlanId.value } })
    } else {
      const result = await $fetch<{ user: HubUserView }>('/api/admin/users', { method: 'POST', body: form })
      if (form.role === 'user' && selectedPlanId.value) await $fetch('/api/admin/plans/assign', { method: 'POST', body: { userId: result.user.id, planId: selectedPlanId.value } })
    }
    await Promise.all([refresh(), refreshGroups(), refreshPlans()])
    showForm.value = false
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '保存用户失败'
  } finally { saving.value = false }
}
async function remove() {
  if (!deletingUser.value) return
  await $fetch(`/api/admin/users/${deletingUser.value.id}`, { method: 'DELETE' })
  deletingUser.value = null
  await Promise.all([refresh(), refreshGroups()])
}
async function openDetail(user: HubUserView) { detail.value = await $fetch(`/api/admin/users/${user.id}`) }
function date(value: number | null) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value) : '从未登录' }
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">IDENTITIES</span><h1>用户管理</h1><p>管理登录账户、角色、状态与用户套餐。普通用户固定使用默认分组。</p></div><button class="button button--primary" @click="openCreate"><IconPlus :size="17" />创建用户</button></header>
    <section class="admin-toolbar">
      <label class="admin-search"><IconSearch :size="17" /><input v-model="search" placeholder="搜索用户名、姓名或邮箱"></label>
      <AppSelect v-model="roleFilter"><option value="">全部角色</option><option value="super_admin">超级管理员</option><option value="admin">管理员</option><option value="operator">操作员</option><option value="auditor">审计员</option><option value="user">用户</option></AppSelect>
      <AppSelect v-model="statusFilter"><option value="">全部状态</option><option value="active">正常</option><option value="disabled">停用</option><option value="locked">锁定</option></AppSelect>
      <AppSelect v-model="groupFilter"><option value="">全部分组</option><option v-for="group in groupData?.groups || []" :key="group.id" :value="group.id">{{ group.name }}</option></AppSelect>
      <span>{{ filtered.length }} / {{ data?.users.length || 0 }} 个用户</span>
    </section>
    <section class="admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>角色 / 状态</th><th>分组</th><th>套餐</th><th>Key</th><th>最后登录</th><th aria-label="操作" /></tr></thead><tbody>
      <tr v-for="user in filtered" :key="user.id"><td><div class="table-primary"><span class="key-glyph"><IconUser :size="16" /></span><div><strong>{{ user.displayName || user.username }}</strong><code>{{ user.username }}</code><small>{{ user.email || '未设置邮箱' }}</small></div></div></td><td><strong>{{ user.role }}</strong><span class="status-dot" :data-status="user.status"><i />{{ user.status }}</span></td><td><span>{{ user.groupNames.join('、') || '未分组' }}</span></td><td>{{ user.subscription?.planName || (user.role === 'user' ? '默认不限量' : '—') }}</td><td><NuxtLink :to="{ path: '/admin/keys', query: { owner: user.id } }" class="admin-text-link"><IconKey :size="14" />{{ user.keyCount }}</NuxtLink></td><td>{{ date(user.lastLoginAt) }}</td><td><div class="table-actions"><button class="icon-button" title="用户详情" @click="openDetail(user)"><IconChartBar :size="16" /></button><button class="icon-button" title="编辑用户" @click="openEdit(user)"><IconEdit :size="16" /></button><button class="icon-button danger" title="删除用户" :disabled="user.keyCount > 0" @click="deletingUser = user"><IconTrash :size="16" /></button></div></td></tr>
      <tr v-if="!filtered.length"><td colspan="7"><div class="admin-empty">没有匹配的用户</div></td></tr>
    </tbody></table></section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true"><header><div><span>USER</span><h2>{{ editing ? '编辑用户' : '创建用户' }}</h2></div><button class="icon-button" title="关闭" @click="showForm = false"><IconX :size="18" /></button></header><form class="admin-form" @submit.prevent="save">
      <div class="form-grid"><label><span>用户名 *</span><input v-model="form.username" required autocomplete="off"></label><label><span>显示名称</span><input v-model="form.displayName"></label></div>
      <div class="form-grid"><label><span>邮箱</span><input v-model="form.email" type="email"></label><label v-if="!editing"><span>初始密码 *</span><input v-model="form.password" type="password" minlength="8" required autocomplete="new-password"></label><div v-else-if="editing.id === session?.user?.id" class="user-password-reset"><span>密码</span><NuxtLink to="/admin/password" class="button button--secondary"><IconLock :size="16" />修改密码</NuxtLink></div><div v-else class="user-password-reset"><span>密码</span><button v-if="!resetPasswordEnabled" type="button" class="button button--secondary" @click="resetPasswordEnabled = true"><IconLock :size="16" />重置密码</button><template v-else><input v-model="resetPassword" type="password" minlength="8" required autocomplete="new-password" placeholder="输入至少 8 位新密码"><button type="button" class="admin-text-link" @click="resetPasswordEnabled = false; resetPassword = ''">取消重置</button></template></div></div>
      <div class="form-grid"><label><span>角色</span><AppSelect v-model="form.role"><option value="user">用户</option><option value="auditor">审计员</option><option value="operator">操作员</option><option value="admin">管理员</option><option value="super_admin">超级管理员</option></AppSelect></label><label v-if="editing"><span>状态</span><AppSelect v-model="form.status"><option value="active">正常</option><option value="disabled">停用</option><option value="locked">锁定</option></AppSelect></label></div>
      <div v-if="form.role === 'user'" class="fixed-access-row"><div><strong>默认分组</strong><small>普通用户固定归属，由“渠道与分组”统一配置权限。</small></div><label><span>用户套餐</span><AppSelect v-model="selectedPlanId"><option v-for="plan in planData?.plans.filter(item => item.status === 'active') || []" :key="plan.id" :value="plan.id">{{ plan.name }}</option></AppSelect></label></div>
      <fieldset v-else class="group-picker"><legend>管理角色所属 Hub 分组</legend><label v-for="group in groupData?.groups || []" :key="group.id"><input v-model="form.groupIds" type="checkbox" :value="group.id"><span>{{ group.name }}<small>{{ group.status === 'active' ? `${group.keyCount} 个 Key` : '已停用' }}</small></span></label></fieldset>
      <p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存用户' }}</button></footer>
    </form></section></div>
    <div v-if="detail" class="log-drawer-backdrop" @click.self="detail = null"><aside class="log-drawer key-usage-drawer"><header><div><span>USER DETAIL</span><code>{{ detail.user.username }}</code></div><button class="icon-button" title="关闭" @click="detail = null"><IconX :size="18" /></button></header><section class="key-usage-identity"><span class="key-glyph"><IconUser :size="17" /></span><div><h2>{{ detail.user.displayName || detail.user.username }}</h2><p>{{ detail.user.groupNames.join('、') || '未分组' }}</p></div><span class="status-dot" :data-status="detail.user.status"><i />{{ detail.user.status }}</span></section><section class="admin-metrics"><article><span>请求</span><strong>{{ detail.usage.requests }}</strong></article><article><span>Token</span><strong>{{ formatTokenCount(detail.usage.tokens) }}</strong></article><article><span>成本</span><strong>${{ detail.usage.cost.toFixed(4) }}</strong></article></section><section class="key-credentials"><header><div><h3>Hub Keys</h3><span>{{ detail.keys.length }} 个</span></div></header><div v-for="key in detail.keys" :key="key.id" class="credential-row"><div><strong>{{ key.name }}</strong><code>{{ key.maskedKey }}</code></div><span class="status-dot" :data-status="key.status"><i />{{ key.status }}</span></div></section><section class="key-usage-recent"><header><h3>最近活动</h3><span>{{ detail.recent.length }} 条</span></header><div v-for="item in detail.recent" :key="item.id"><code>{{ item.requestId }}</code><span>{{ item.model || '—' }}</span><strong>{{ item.httpStatus || '—' }}</strong><small>{{ date(item.createdAt) }}</small></div><p v-if="!detail.recent.length">尚无请求记录</p></section></aside></div>
    <AppConfirmDialog :open="Boolean(deletingUser)" title="删除用户" :message="`确定删除用户“${deletingUser?.username || ''}”？该操作无法恢复。`" @close="deletingUser = null" @confirm="remove" />
  </div>
</template>
