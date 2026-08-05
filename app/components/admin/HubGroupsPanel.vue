<script setup lang="ts">
import { IconEdit, IconSearch, IconTrash, IconUsers, IconX } from '@tabler/icons-vue'
import type { HubGroupChannelRuleView, HubGroupView, HubUserView } from '#shared/types/access-control'
import type { ChannelView } from '#shared/types/hub'
import { formatTokenCount } from '#shared/utils/number-format'

const { data, refresh } = await useFetch<{ groups: HubGroupView[] }>('/api/admin/groups')
const { data: userData, refresh: refreshUsers } = await useFetch<{ users: HubUserView[] }>('/api/admin/users')
const { data: channelData } = await useFetch<{ channels: ChannelView[] }>('/api/admin/channels')
const { data: modelData } = await useFetch<{ models: Array<{ publicModel: string }> }>('/api/admin/models')
const { show: showToast } = useAppToast()
const search = ref('')
const editing = ref<HubGroupView | null>(null)
const showForm = ref(false)
const saving = ref(false)
const error = ref('')
const deleting = ref<HubGroupView | null>(null)
const DEFAULT_GROUP_ID = '00000000-0000-4000-8000-000000000001'
const endpoints = ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/images/generations', '/v1/images/edits']
const form = reactive<Record<string, any>>({})
const empty = () => ({ name: '', description: '', status: 'active', allowedEndpoints: [] as string[], rpmLimit: '', concurrencyLimit: '', dailyRequestLimit: '', dailyTokenLimit: '', dailyCostLimit: '', weeklyRequestLimit: '', weeklyTokenLimit: '', weeklyCostLimit: '', monthlyRequestLimit: '', monthlyTokenLimit: '', monthlyCostLimit: '', priceMultiplier: 1, userIds: [] as string[], models: [] as string[], channelPolicyMode: 'inherit', channelRules: [] as HubGroupChannelRuleView[] })
const filtered = computed(() => (data.value?.groups || []).filter(group => `${group.name} ${group.description || ''}`.toLowerCase().includes(search.value.toLowerCase())))
const membershipCandidates = computed(() => (userData.value?.users || []).filter(user => editing.value?.id === DEFAULT_GROUP_ID || user.role !== 'user'))

function openCreate() { editing.value = null; Object.assign(form, empty()); error.value = ''; showForm.value = true }
function expandedChannelRules(rules: HubGroupChannelRuleView[] | null) {
  return (channelData.value?.channels || []).map(channel => {
    const existing = rules?.find(rule => rule.channelId === channel.id)
    return existing ? { ...existing } : { channelId: channel.id, enabled: rules === null, priorityOverride: null, weightOverride: null }
  })
}
function openEdit(group: HubGroupView) {
  editing.value = group
  Object.assign(form, empty(), group, {
    channelPolicyMode: group.channelRules.length ? 'custom' : 'inherit',
    channelRules: group.channelRules.length ? expandedChannelRules(group.channelRules) : []
  })
  error.value = ''
  showForm.value = true
}
function changeChannelPolicy() { form.channelRules = form.channelPolicyMode === 'custom' ? expandedChannelRules(null) : [] }
function channelFor(id: string) { return channelData.value?.channels.find(channel => channel.id === id) }
function optionalNumber(value: unknown) { return value === null || value === '' || value === undefined ? null : Number(value) }
function payload() {
  const result = { ...form }
  for (const key of ['rpmLimit', 'concurrencyLimit', 'dailyRequestLimit', 'dailyTokenLimit', 'dailyCostLimit', 'weeklyRequestLimit', 'weeklyTokenLimit', 'weeklyCostLimit', 'monthlyRequestLimit', 'monthlyTokenLimit', 'monthlyCostLimit']) result[key] = form[key] === '' ? null : Number(form[key])
  result.priceMultiplier = Number(form.priceMultiplier)
  result.channelRules = form.channelPolicyMode === 'custom' ? form.channelRules.map((rule: HubGroupChannelRuleView) => ({ channelId: rule.channelId, enabled: rule.enabled, priorityOverride: optionalNumber(rule.priorityOverride), weightOverride: optionalNumber(rule.weightOverride) })) : []
  for (const key of ['channelPolicyMode', 'channelIds', 'keyCount', 'usage', 'createdAt', 'updatedAt', 'userNames']) delete result[key]
  return result
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    if (editing.value) await $fetch(`/api/admin/groups/${editing.value.id}`, { method: 'PATCH', body: payload() })
    else await $fetch('/api/admin/groups', { method: 'POST', body: payload() })
    await Promise.all([refresh(), refreshUsers()])
    showForm.value = false
    showToast(editing.value ? '分组策略已更新' : '分组已创建', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '保存分组失败'
  } finally { saving.value = false }
}
async function remove() {
  if (!deleting.value) return
  try {
    await $fetch(`/api/admin/groups/${deleting.value.id}`, { method: 'DELETE' })
    deleting.value = null
    await Promise.all([refresh(), refreshUsers()])
    showToast('分组已删除', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    showToast(failure.data?.message || failure.message || '删除分组失败', 'error')
  }
}
defineExpose({ openCreate })
</script>

<template>
  <div class="hub-groups-panel">
    <section class="admin-toolbar">
      <label class="admin-search"><IconSearch :size="17" /><input v-model="search" placeholder="搜索分组"></label>
      <span>{{ filtered.length }} / {{ data?.groups.length || 0 }} 个分组</span>
    </section>
    <section class="admin-table-wrap"><table class="admin-table"><thead><tr><th>分组</th><th>状态</th><th>成员 / Key</th><th>权限</th><th>共享限制</th><th>倍率</th><th aria-label="操作" /></tr></thead><tbody>
      <tr v-for="group in filtered" :key="group.id"><td><div class="table-primary"><span class="key-glyph"><IconUsers :size="16" /></span><div><strong>{{ group.name }}</strong><small>{{ group.description || '无说明' }}</small></div></div></td><td><span class="status-dot" :data-status="group.status"><i />{{ group.status === 'active' ? '运行中' : '已停用' }}</span></td><td><strong>{{ group.userIds.length }} 位成员</strong><small class="table-sub">{{ group.keyCount }} 个 Key</small></td><td><strong>{{ group.models.length || '全部' }} 个模型</strong><small class="table-sub">{{ group.allowedEndpoints.length || '全部' }} 个端点 · {{ group.channelIds.length || '全部' }} 个渠道</small></td><td><code>{{ group.rpmLimit || '∞' }} RPM</code><small class="table-sub">{{ group.concurrencyLimit || '∞' }} 并发 · {{ group.usage.requests }} 请求 / {{ formatTokenCount(group.usage.tokens) }} Token</small></td><td>{{ group.priceMultiplier }}×<small class="table-sub">${{ group.usage.cost.toFixed(4) }}</small></td><td><div class="table-actions"><button class="icon-button" title="编辑分组" @click="openEdit(group)"><IconEdit :size="16" /></button><button class="icon-button danger" title="删除分组" :disabled="group.id === DEFAULT_GROUP_ID || group.keyCount > 0" @click="deleting = group"><IconTrash :size="16" /></button></div></td></tr>
      <tr v-if="!filtered.length"><td colspan="7"><div class="admin-empty">没有匹配的分组</div></td></tr>
    </tbody></table></section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true"><header><div><span>GROUP</span><h2>{{ editing ? '编辑分组策略' : '创建分组' }}</h2></div><button class="icon-button" title="关闭" @click="showForm = false"><IconX :size="18" /></button></header><form class="admin-form" @submit.prevent="save">
      <div class="form-grid"><label><span>分组名称 *</span><input v-model="form.name" required></label><label><span>状态</span><AppSelect v-model="form.status"><option value="active">运行中</option><option value="disabled">已停用</option></AppSelect></label></div><label><span>说明</span><input v-model="form.description"></label>
      <fieldset class="endpoint-picker"><legend>允许端点（不选择表示继承全部）</legend><label v-for="endpoint in endpoints" :key="endpoint"><input v-model="form.allowedEndpoints" type="checkbox" :value="endpoint"><span>{{ endpoint.replace('/v1/', '') }}</span></label></fieldset>
      <section class="form-section"><header><h3>共享速率与倍率</h3><span>对分组内所有 Key 合并执行</span></header><div class="form-grid"><label><span>每分钟请求数</span><input v-model="form.rpmLimit" type="number" min="1"></label><label><span>最大并发</span><input v-model="form.concurrencyLimit" type="number" min="1"></label><label><span>价格倍率</span><input v-model="form.priceMultiplier" type="number" min="0" step="0.01"></label></div></section>
      <section class="form-section"><header><h3>共享周期额度</h3><span>请求 / Token / USD</span></header><div class="quota-form-grid"><template v-for="period in [{id:'daily',label:'每日'},{id:'weekly',label:'每周'},{id:'monthly',label:'每月'}]" :key="period.id"><strong>{{ period.label }}</strong><input v-model="form[`${period.id}RequestLimit`]" type="number" min="1" placeholder="请求数"><input v-model="form[`${period.id}TokenLimit`]" type="number" min="1" placeholder="Token"><input v-model="form[`${period.id}CostLimit`]" type="number" min="0" step="0.01" placeholder="USD"></template></div></section>
      <section class="form-section"><header><h3>成员</h3><span>{{ editing?.id === DEFAULT_GROUP_ID ? '普通用户固定归属默认分组' : '普通用户不加入自定义分组' }}</span></header><fieldset class="group-picker"><label v-for="user in membershipCandidates" :key="user.id"><input v-model="form.userIds" type="checkbox" :value="user.id" :disabled="user.role === 'user'"><span>{{ user.displayName || user.username }}<small>{{ user.username }} · {{ user.role }}</small></span></label></fieldset></section>
      <section class="form-section"><header><h3>允许模型</h3><span>不选择表示继承系统全部</span></header><fieldset class="group-picker"><label v-for="model in modelData?.models || []" :key="model.publicModel"><input v-model="form.models" type="checkbox" :value="model.publicModel"><span><code>{{ model.publicModel }}</code></span></label></fieldset></section>
      <section class="form-section"><header><h3>渠道池</h3><span>控制可用渠道及组内调度参数</span></header>
        <div class="channel-policy-mode"><label><span>策略模式</span><AppSelect v-model="form.channelPolicyMode" @change="changeChannelPolicy"><option value="inherit">继承系统全部渠道</option><option value="custom">自定义渠道规则</option></AppSelect></label><small>{{ form.channelPolicyMode === 'inherit' ? '系统新增渠道会自动进入该分组' : '优先级和权重留空时沿用渠道全局配置' }}</small></div>
        <div v-if="form.channelPolicyMode === 'custom'" class="group-channel-rules"><article v-for="rule in form.channelRules" :key="rule.channelId" class="group-channel-rule" :data-enabled="rule.enabled"><label class="group-channel-rule__toggle"><input v-model="rule.enabled" type="checkbox"><span><strong>{{ channelFor(rule.channelId)?.name || '已删除渠道' }}</strong><small>{{ channelFor(rule.channelId)?.type || 'unknown' }} · {{ channelFor(rule.channelId)?.healthStatus || 'unknown' }}</small></span></label><label><span>优先级覆盖</span><input v-model="rule.priorityOverride" type="number" min="0" placeholder="继承" :disabled="!rule.enabled"></label><label><span>权重覆盖</span><input v-model="rule.weightOverride" type="number" min="1" placeholder="继承" :disabled="!rule.enabled"></label></article><div v-if="!form.channelRules.length" class="admin-empty">当前没有可配置渠道</div></div>
      </section>
      <p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存分组' }}</button></footer>
    </form></section></div>
    <AppConfirmDialog :open="Boolean(deleting)" title="删除分组" :message="`确定删除分组“${deleting?.name || ''}”？该操作无法恢复。`" @close="deleting = null" @confirm="remove" />
  </div>
</template>
