<script setup lang="ts">
import { IconActivityHeartbeat, IconChartBar, IconCheck, IconChevronDown, IconCloudDownload, IconPlugConnected, IconPlus, IconRefresh, IconRoute, IconSearch, IconTrash, IconX } from '@tabler/icons-vue'
import type { HubGroupView, HubUserView } from '#shared/types/access-control'
import type { ChannelAccessScope, ChannelModelView, ChannelProtocol, ChannelProtocolBindingView, ChannelType, ChannelView, ProbeModelCatalogView } from '#shared/types/hub'
import { relayProviderPresets } from '#shared/relay-provider-presets'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '资源管理 | Zephyr Hub' })

type ResourceTab = 'channels' | 'groups' | 'plans'
const route = useRoute()
const router = useRouter()
const resourceTabs: Array<{ id: ResourceTab; label: string }> = [
  { id: 'channels', label: '渠道' },
  { id: 'groups', label: '分组' },
  { id: 'plans', label: '套餐' }
]
function resourceTab(value: unknown): ResourceTab {
  return value === 'groups' || value === 'plans' ? value : 'channels'
}
const activeTab = ref<ResourceTab>(resourceTab(route.query.tab))
const createLabel = computed(() => ({ channels: '添加渠道', groups: '创建分组', plans: '新建套餐' })[activeTab.value])

const { data, refresh } = await useFetch<{ channels: ChannelView[] }>('/api/admin/channels')
const { data: settingsData } = await useFetch<{ settings: { defaultTimeoutMs: number } }>('/api/admin/settings')
const { data: userData } = await useFetch<{ users: HubUserView[] }>('/api/admin/users')
const { data: groupData } = await useFetch<{ groups: HubGroupView[] }>('/api/admin/groups')
const { data: probeModelData } = await useFetch<{ models: ProbeModelCatalogView[] }>('/api/admin/probe-models')
const { show: showToast } = useAppToast()
const showForm = ref(false)
const editing = ref<ChannelView | null>(null)
const saving = ref(false)
const syncingModels = ref(false)
const modelSyncResult = ref('')
const showAvailableModels = ref(false)
const modelSearch = ref('')
const testing = ref(new Set<string>())
const connectivityTesting = ref(new Set<string>())
const selectedPresetId = ref('')
const error = ref('')
const groupPanel = ref<{ openCreate: () => void } | null>(null)
const planPanel = ref<{ openCreate: () => void } | null>(null)
const deletingChannel = ref<ChannelView | null>(null)
const inspectingCache = ref<ChannelView | null>(null)
const endpointOptions = ['/v1/chat/completions','/v1/responses','/v1/embeddings','/v1/images/generations','/v1/images/edits']
const protocolOptions: Array<{ id: ChannelProtocol; label: string; detail: string }> = [
  { id: 'anthropic_messages', label: 'Anthropic Messages', detail: 'Claude Code 原生' },
  { id: 'openai_responses', label: 'OpenAI Responses', detail: 'Codex 原生' },
  { id: 'openai_chat', label: 'OpenAI Chat', detail: '通用兼容 / Claude 转换' }
]
const form = reactive({ name: '', type: 'cpa' as ChannelType, baseUrl: '', apiKey: '', enabled: true, priority: 100, weight: 1, maxConcurrency: 20, timeoutMs: 120000, priceMultiplier: 1, accessScope: 'all' as ChannelAccessScope, grantedUserIds: [] as string[], grantedGroupIds: [] as string[], protocols: [] as ChannelProtocolBindingView[], models: [] as ChannelModelView[], clientIdentityMode: 'standard' as 'standard' | 'passthrough' })
const manualModels = computed(() => form.models.filter(model => !model.id || model.publicModel !== model.upstreamModel || model.endpoints.length > 0))
const availableModels = computed(() => {
  const search = modelSearch.value.trim().toLowerCase()
  return form.models
    .filter(model => model.publicModel && model.upstreamModel)
    .filter(model => !search || model.publicModel.toLowerCase().includes(search) || model.upstreamModel.toLowerCase().includes(search))
    .sort((left, right) => left.publicModel.localeCompare(right.publicModel))
})

watch(() => form.type, (type) => {
  if (type === 'sub2api') {
    form.models = form.models.filter(model => model.publicModel && model.upstreamModel)
  } else if (!form.models.length) {
    addModel()
  }
})

function protocolBinding(protocol: ChannelProtocol): ChannelProtocolBindingView {
  return { protocol, enabled: true, baseUrlOverride: null, authScheme: protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer', apiVersion: protocol === 'anthropic_messages' ? '2023-06-01' : null, probeModel: null, verificationStatus: 'unknown', verifiedAt: null, lastError: null }
}
function reset() { Object.assign(form, { name: '', type: 'cpa', baseUrl: '', apiKey: '', enabled: true, priority: 100, weight: 1, maxConcurrency: 20, timeoutMs: settingsData.value?.settings.defaultTimeoutMs || 120000, priceMultiplier: 1, accessScope: 'all', grantedUserIds: [], grantedGroupIds: [], protocols: [protocolBinding('openai_responses'), protocolBinding('openai_chat')], models: [{ publicModel: '', upstreamModel: '', enabled: true, endpoints: [] }], clientIdentityMode: 'standard' }); selectedPresetId.value = '' }
function create() { editing.value = null; reset(); error.value = ''; modelSyncResult.value = ''; modelSearch.value = ''; showAvailableModels.value = false; showForm.value = true }
function edit(item: ChannelView) { if (item.ownerKind !== 'platform') return; editing.value = item; Object.assign(form, { ...item, apiKey: '', grantedUserIds: [...item.grantedUserIds], grantedGroupIds: [...item.grantedGroupIds], protocols: item.protocols.map(protocol => ({ ...protocol })), models: item.models.map(model => ({ ...model, endpoints: [...model.endpoints], protocolBindings: model.protocolBindings?.map(binding => ({ ...binding, capabilities: { ...binding.capabilities } })) })) }); error.value = ''; modelSyncResult.value = ''; modelSearch.value = ''; showAvailableModels.value = false; showForm.value = true }
function addModel() { form.models.push({ publicModel: '', upstreamModel: '', enabled: true, endpoints: [] }) }
function removeModel(model: ChannelModelView) { const index = form.models.indexOf(model); if (index >= 0) form.models.splice(index, 1) }
function toggleProtocol(protocol: ChannelProtocol) {
  const index = form.protocols.findIndex(item => item.protocol === protocol)
  if (index >= 0) form.protocols.splice(index, 1)
  else form.protocols.push(protocolBinding(protocol))
}
function selectedProtocol(protocol: ChannelProtocol) { return form.protocols.some(item => item.protocol === protocol) }
function protocolFor(protocol: ChannelProtocol) { return form.protocols.find(item => item.protocol === protocol) }
function probeModelsFor(protocol: ChannelProtocol) { return probeModelData.value?.models.filter(item => item.protocol === protocol && item.enabled) || [] }
function applyPreset() {
  const preset = relayProviderPresets.find(item => item.id === selectedPresetId.value)
  if (!preset) return
  const protocols = preset.protocols.map(item => ({ ...protocolBinding(item.protocol), authScheme: item.authScheme, baseUrlOverride: item.baseUrlOverride || null, probeModel: probeModelsFor(item.protocol)[0]?.model || null }))
  Object.assign(form, { name: preset.name, baseUrl: preset.baseUrl, type: protocols.length === 1 && protocols[0]?.protocol === 'anthropic_messages' ? 'anthropic_compatible' : 'openai_compatible', protocols })
}
function payload() {
  const enabledProtocols = form.protocols.map(item => ({ ...item, id: undefined }))
  return {
    ...form,
    protocols: enabledProtocols,
    grantedUserIds: form.accessScope === 'restricted' ? form.grantedUserIds : [],
    grantedGroupIds: form.accessScope === 'restricted' ? form.grantedGroupIds : [],
    models: form.models.map(model => ({
      ...model,
      protocolBindings: enabledProtocols.map(protocol => {
        const existing = model.protocolBindings?.find(binding => binding.protocol === protocol.protocol)
        return existing || { protocol: protocol.protocol, upstreamModel: model.upstreamModel, enabled: model.enabled, capabilities: { streaming: true, tools: true } }
      })
    }))
  }
}
async function save() {
  if (!form.protocols.length) { error.value = '请至少选择一种上游协议'; return }
  if (form.protocols.some(protocol => !protocol.probeModel?.trim())) { error.value = '请为每个上游协议指定检测模型'; return }
  saving.value = true; error.value = ''
  try {
    if (editing.value) await $fetch(`/api/admin/channels/${editing.value.id}`, { method: 'PATCH', body: payload() })
    else await $fetch('/api/admin/channels', { method: 'POST', body: payload() })
    showForm.value = false; await refresh()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '保存失败' }
  finally { saving.value = false }
}
async function test(item: ChannelView) {
  testing.value = new Set(testing.value).add(item.id)
  try { await $fetch(`/api/admin/channels/${item.id}/test`, { method: 'POST' }); await refresh() }
  finally { const next = new Set(testing.value); next.delete(item.id); testing.value = next }
}
async function testConnectivity(item: ChannelView) {
  connectivityTesting.value = new Set(connectivityTesting.value).add(item.id)
  try {
    const result = await $fetch<{ status: 'operational' | 'degraded' | 'failed'; success: boolean; message: string; responseTimeMs: number; httpStatus: number | null }>(`/api/admin/channels/${item.id}/connectivity`, { method: 'POST' })
    if (result.success) {
      showToast(`${item.name} ${result.status === 'degraded' ? '可以连通，但响应较慢' : '连通正常'}（${result.responseTimeMs} ms · HTTP ${result.httpStatus}）`, result.status === 'degraded' ? 'info' : 'success')
    } else {
      showToast(`${item.name} 无法连通：${result.message}`, 'error')
    }
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    showToast(failure.data?.message || failure.message || '连通检测失败', 'error')
  } finally {
    const next = new Set(connectivityTesting.value); next.delete(item.id); connectivityTesting.value = next
  }
}
async function syncModels() {
  if (!editing.value) return
  syncingModels.value = true; error.value = ''; modelSyncResult.value = ''
  try {
    const result = await $fetch<{ discovered: number; added: number }>(`/api/admin/channels/${editing.value.id}/models/sync`, { method: 'POST' })
    await refresh()
    const updated = data.value?.channels.find(item => item.id === editing.value?.id)
    if (updated) form.models = updated.models.map(model => ({ ...model, endpoints: [...model.endpoints] }))
    modelSyncResult.value = `已读取 ${result.discovered} 个模型，新增 ${result.added} 个`
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    error.value = failure.data?.message || failure.message || '同步模型失败'
  } finally { syncingModels.value = false }
}
async function toggle(item: ChannelView) { await $fetch(`/api/admin/channels/${item.id}`, { method: 'PATCH', body: { enabled: !item.enabled } }); await refresh() }
async function remove() {
  if (!deletingChannel.value) return
  saving.value = true
  try {
    await $fetch(`/api/admin/channels/${deletingChannel.value.id}`, { method: 'DELETE' })
    deletingChannel.value = null
    await refresh()
    showToast('渠道已删除', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    showToast(failure.data?.message || failure.message || '删除渠道失败', 'error')
  } finally {
    saving.value = false
  }
}
async function switchTab(value: ResourceTab) {
  activeTab.value = value
  await router.replace({ query: value === 'channels' ? {} : { tab: value } })
}
function createActiveResource() {
  if (activeTab.value === 'channels') create()
  else if (activeTab.value === 'groups') groupPanel.value?.openCreate()
  else planPanel.value?.openCreate()
}
function time(value: number | null) { return value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value) : '尚未检测' }
function protocolLabel(protocol: ChannelProtocol) { return ({ anthropic_messages: 'Messages', openai_responses: 'Responses', openai_chat: 'Chat' })[protocol] }
function protocolCacheLabel(protocol: string) { return protocolLabel(protocol as ChannelProtocol) || protocol }
function compatibility(item: ChannelView) {
  const protocols = new Set(item.protocols.filter(protocol => protocol.enabled).map(protocol => protocol.protocol))
  return [
    protocols.has('anthropic_messages') ? 'Claude 原生' : protocols.has('openai_chat') ? 'Claude 转换' : '',
    protocols.has('openai_responses') ? 'Codex 原生' : ''
  ].filter(Boolean)
}
function accessLabel(item: ChannelView) {
  if (item.ownerKind === 'user') return '仅所有者'
  if (item.accessScope === 'all') return '全部用户'
  return `${item.grantedGroupIds.length} 组 / ${item.grantedUserIds.length} 人`
}
function percent(value: number | null) { return value === null ? '—' : `${value.toFixed(1)}%` }

watch(() => route.query.tab, value => { activeTab.value = resourceTab(value) })
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">RESOURCE CONTROL</span><h1 class="text-balance">资源管理</h1><p class="text-pretty">统一维护 Hub 上游连接、访问分组和用户套餐。</p></div><div class="admin-header-actions"><button class="button button--primary" type="button" @click="createActiveResource"><IconPlus :size="17" />{{ createLabel }}</button></div></header>
    <div class="admin-page-tabs" role="tablist" aria-label="资源管理类型">
      <button v-for="item in resourceTabs" :key="item.id" type="button" role="tab" :aria-selected="activeTab === item.id" :class="{ active: activeTab === item.id }" @click="switchTab(item.id)">{{ item.label }}</button>
    </div>

    <template v-if="activeTab === 'channels'">
    <section class="channel-ledger">
      <article v-for="item in data?.channels || []" :key="item.id" class="channel-row">
        <div class="channel-row__identity"><span class="channel-logo" :data-type="item.type"><IconRoute :size="20" /></span><div><strong>{{ item.name }}</strong><code>{{ item.baseUrl }}</code><small>{{ item.ownerKind === 'platform' ? '平台' : item.ownerUserName || '用户私有' }} · {{ item.type.toUpperCase() }} · 优先级 {{ item.priority }}</small></div></div>
        <div class="channel-row__health"><span class="status-dot" :data-status="!item.enabled ? 'disabled' : item.circuitState === 'open' ? 'unhealthy' : item.circuitState === 'half_open' ? 'unknown' : item.healthStatus"><i />{{ !item.enabled ? '已停用' : item.circuitState === 'open' ? '已熔断' : item.circuitState === 'half_open' ? '等待探测' : item.healthStatus === 'healthy' ? '健康' : item.healthStatus === 'unhealthy' ? '异常' : '待检测' }}</span><small>{{ time(item.lastHealthCheckAt) }}</small><em v-if="item.lastHealthError">{{ item.lastHealthError }}</em></div>
        <div class="channel-row__models"><span>协议 / 客户端</span><strong>{{ item.protocols.filter(protocol => protocol.enabled).map(protocol => protocolLabel(protocol.protocol)).join(' · ') || '未配置' }}</strong><small>{{ compatibility(item).join(' · ') || '无客户端兼容' }} · {{ item.models.filter(model => model.enabled).length }} 个模型</small></div>
        <div class="channel-row__policy"><span>可用范围</span><strong>{{ accessLabel(item) }}</strong><small>{{ item.weight }}× 权重 · {{ item.maxConcurrency }} 并发</small></div>
        <div class="table-actions"><button class="icon-button" type="button" title="缓存诊断" aria-label="缓存诊断" @click="inspectingCache = item"><IconChartBar :size="17" /></button><button class="icon-button" type="button" title="检测连通" aria-label="检测连通" :disabled="connectivityTesting.has(item.id)" @click="testConnectivity(item)"><IconPlugConnected :class="{ 'is-spinning': connectivityTesting.has(item.id) }" :size="17" /></button><button class="icon-button" type="button" title="健康检测" aria-label="健康检测" :disabled="testing.has(item.id)" @click="test(item)"><IconRefresh :class="{ 'is-spinning': testing.has(item.id) }" :size="17" /></button><button class="icon-button" type="button" :title="item.enabled ? '停用' : '启用'" :aria-label="item.enabled ? '停用渠道' : '启用渠道'" @click="toggle(item)"><IconActivityHeartbeat :size="17" /></button><button v-if="item.ownerKind === 'platform'" class="button button--quiet button--small" type="button" @click="edit(item)">配置</button><button v-if="item.ownerKind === 'platform'" class="icon-button danger" type="button" title="删除渠道" aria-label="删除渠道" @click="deletingChannel = item"><IconTrash :size="16" /></button></div>
      </article>
      <div v-if="!data?.channels.length" class="admin-empty admin-empty--large">还没有渠道。添加 CPA 或 Sub2API 后才能开始转发。</div>
    </section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true" aria-labelledby="channel-dialog-title">
      <header><div><span>UPSTREAM CHANNEL</span><h2 id="channel-dialog-title" class="text-balance">{{ editing ? '编辑渠道' : '连接新渠道' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showForm = false"><IconX :size="18" /></button></header>
      <form class="admin-form" autocomplete="off" @submit.prevent="save">
        <label v-if="!editing"><span>预设服务商</span><AppSelect v-model="selectedPresetId" @update:model-value="applyPreset"><option value="">自定义</option><option v-for="preset in relayProviderPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option></AppSelect><small>选择后自动填写名称、地址、协议与认证方式</small></label>
        <div class="form-grid"><label><span>渠道名称 *</span><input v-model="form.name" required placeholder="例如：CPA 主节点"></label><label><span>渠道类型 *</span><AppSelect v-model="form.type" :disabled="Boolean(editing)"><option value="cpa">CPA / CLIProxyAPI</option><option value="sub2api">Sub2API</option><option value="openai_compatible">OpenAI 兼容中转</option><option value="anthropic_compatible">Anthropic 兼容中转</option></AppSelect></label></div>
        <label for="admin-channel-origin"><span>Base URL *</span><input id="admin-channel-origin" v-model="form.baseUrl" name="admin_channel_origin" type="url" required autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="https://upstream.example.com"></label>
        <label for="admin-channel-token"><span>上游 API Key {{ editing ? '（留空保持不变）' : '*' }}</span><input id="admin-channel-token" v-model="form.apiKey" name="admin_channel_token" type="password" :required="!editing" autocomplete="new-password" autocapitalize="none" spellcheck="false" data-1p-ignore data-lpignore="true"></label>
        <section class="form-section"><header><div><h3>上游协议</h3><span>每个端点使用独立检测模型，认证失败时自动补测另一种认证</span></div></header><datalist v-for="option in protocolOptions" :id="`admin-probe-models-${option.id}`" :key="`probe-${option.id}`"><option v-for="model in probeModelsFor(option.id)" :key="model.id" :value="model.model">{{ model.vendor }} · {{ model.displayName }}</option></datalist><div class="channel-protocol-picker"><button v-for="option in protocolOptions" :key="option.id" type="button" :class="{ active: selectedProtocol(option.id) }" @click="toggleProtocol(option.id)"><IconCheck :size="15" /><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button></div><div class="channel-auth-schemes"><label v-for="protocol in form.protocols" :key="protocol.protocol"><span>{{ protocolOptions.find(item => item.id === protocol.protocol)?.label }} 默认认证</span><AppSelect v-model="protocol.authScheme"><option value="bearer">Bearer</option><option value="x_api_key">x-api-key</option></AppSelect><input v-model="protocol.probeModel" :list="`admin-probe-models-${protocol.protocol}`" required placeholder="检测模型"></label></div><div class="channel-compatibility"><span>Claude Code：{{ selectedProtocol('anthropic_messages') ? '原生' : selectedProtocol('openai_chat') ? '协议转换' : '不可用' }}</span><span>Codex：{{ selectedProtocol('openai_responses') || selectedProtocol('openai_chat') ? '可用' : '不可用' }}</span></div></section>
        <section class="form-section channel-compat-options"><header><div><h3>兼容设置</h3><span>模型只在手动同步时更新</span></div></header><label class="switch"><input v-model="form.clientIdentityMode" type="checkbox" true-value="passthrough" false-value="standard"><span />透传真实 Claude Code / Codex 客户端身份</label></section>
        <section class="form-section"><header><div><h3>可用范围</h3><span>{{ form.accessScope === 'all' ? '所有用户均可使用' : `已选 ${form.grantedGroupIds.length} 个分组、${form.grantedUserIds.length} 个用户` }}</span></div></header><div class="channel-access-mode"><label><input v-model="form.accessScope" type="radio" value="all"><span>全部用户</span></label><label><input v-model="form.accessScope" type="radio" value="restricted"><span>部分用户</span></label></div><template v-if="form.accessScope === 'restricted'"><h4 class="channel-grant-title">权限分组</h4><fieldset class="group-picker"><label v-for="group in groupData?.groups || []" :key="group.id"><input v-model="form.grantedGroupIds" type="checkbox" :value="group.id"><span>{{ group.name }}<small>{{ group.userIds.length }} 位成员</small></span></label></fieldset><h4 class="channel-grant-title">单独授权用户</h4><fieldset class="group-picker"><label v-for="user in userData?.users || []" :key="user.id"><input v-model="form.grantedUserIds" type="checkbox" :value="user.id"><span>{{ user.displayName || user.username }}<small>{{ user.username }}</small></span></label></fieldset></template></section>
        <div class="form-grid form-grid--four"><label><span>优先级</span><input v-model.number="form.priority" type="number" min="0"></label><label><span>权重</span><input v-model.number="form.weight" type="number" min="1"></label><label><span>最大并发</span><input v-model.number="form.maxConcurrency" type="number" min="1"></label><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="1000"></label></div>
        <section v-if="form.type === 'sub2api'" class="form-section auto-model-sync"><header><div><h3>自动模型发现</h3><span>{{ editing ? `${form.models.filter(model => model.publicModel && model.upstreamModel).length} 个已同步模型` : '保存时从上游读取' }}</span></div><div v-if="editing" class="auto-model-actions"><button type="button" class="button button--quiet button--small" @click="showAvailableModels = !showAvailableModels"><IconChevronDown :class="{ 'is-rotated': showAvailableModels }" :size="15" />{{ showAvailableModels ? '收起模型' : '查看模型' }}</button><button type="button" class="button button--quiet button--small" :disabled="syncingModels" @click="syncModels"><IconCloudDownload :size="15" />{{ syncingModels ? '同步中' : '同步上游模型' }}</button></div></header><p>系统读取上游 <code>/v1/models</code>，自动建立同名映射；后续健康检查会持续补充新模型，且不会覆盖手工映射。</p><small v-if="modelSyncResult">{{ modelSyncResult }}</small><div v-if="showAvailableModels" class="available-models"><label><IconSearch :size="15" /><input v-model="modelSearch" type="search" placeholder="搜索模型"></label><div class="available-models__list"><div v-for="model in availableModels" :key="model.id || `${model.publicModel}:${model.upstreamModel}`"><code>{{ model.publicModel }}</code><span v-if="model.publicModel !== model.upstreamModel">→ <code>{{ model.upstreamModel }}</code></span><em :data-source="manualModels.includes(model) ? 'manual' : 'automatic'">{{ manualModels.includes(model) ? '手工' : '自动' }}</em></div><p v-if="!availableModels.length">没有匹配的模型</p></div></div></section>
        <section v-if="form.type === 'sub2api'" class="form-section"><header><div><h3>手动模型映射</h3><span>可选 · 同名冲突时手工配置优先</span></div><button type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" /> 添加映射</button></header>
          <div v-if="manualModels.length" class="model-mapping-list"><div v-for="(model, index) in manualModels" :key="model.id || index" class="model-mapping"><input v-model="model.publicModel" required placeholder="Hub 模型名"><span>→</span><input v-model="model.upstreamModel" required placeholder="上游模型名"><AppSelect v-model="model.endpoints" multiple title="限制支持端点（留空表示全部）"><option v-for="endpoint in endpointOptions" :key="endpoint" :value="endpoint">{{ endpoint.replace('/v1/', '') }}</option></AppSelect><button type="button" class="icon-button danger" title="移除" aria-label="移除模型映射" @click="removeModel(model)"><IconX :size="15" /></button></div></div><p v-else class="form-section-empty">当前没有手工映射，全部使用上游自动发现结果。</p>
        </section>
        <section v-else class="form-section"><header><h3>模型映射</h3><button type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" /> 添加模型</button></header>
          <div class="model-mapping-list"><div v-for="(model, index) in form.models" :key="index" class="model-mapping"><input v-model="model.publicModel" required placeholder="Hub 模型名"><span>→</span><input v-model="model.upstreamModel" required placeholder="上游模型名"><AppSelect v-model="model.endpoints" multiple title="支持端点"><option v-for="endpoint in endpointOptions" :key="endpoint" :value="endpoint">{{ endpoint.replace('/v1/', '') }}</option></AppSelect><button type="button" class="icon-button danger" title="移除" aria-label="移除模型映射" @click="removeModel(model)"><IconX :size="15" /></button></div></div>
        </section>
        <p v-if="error" class="form-error">{{ error }}</p><footer><label class="switch"><input v-model="form.enabled" type="checkbox"><span />启用渠道</label><div><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button type="submit" class="button button--primary" :disabled="saving">{{ saving ? '正在保存' : '保存渠道' }}</button></div></footer>
      </form>
    </section></div>
    <div v-if="inspectingCache" class="admin-modal-backdrop" @click.self="inspectingCache = null"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true"><header><div><span>CACHE DIAGNOSTICS</span><h2>{{ inspectingCache.name }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="inspectingCache = null"><IconX :size="18" /></button></header><div class="cache-diagnostics"><div class="cache-summary"><div><span>Token 命中率</span><strong>{{ percent(inspectingCache.cache.tokenHitRate) }}</strong><small>{{ inspectingCache.cache.cacheReadTokens.toLocaleString() }} 读取 / {{ inspectingCache.cache.inputTokens.toLocaleString() }} 输入</small></div><div><span>请求命中率</span><strong>{{ percent(inspectingCache.cache.requestHitRate) }}</strong><small>按上游真实 cached token 统计</small></div><div><span>亲和保持率</span><strong>{{ percent(inspectingCache.cache.affinityReuseRate) }}</strong><small>{{ inspectingCache.cache.affinityFailovers }} 次亲和故障转移</small></div><div><span>缓存创建 Token</span><strong>{{ inspectingCache.cache.cacheCreationTokens.toLocaleString() }}</strong><small>上游真实返回值</small></div></div><section><h3>按协议</h3><table><thead><tr><th>协议</th><th>Token 命中</th><th>请求命中</th><th>亲和保持</th><th>故障转移</th></tr></thead><tbody><tr v-for="slice in inspectingCache.cache.protocols" :key="slice.label"><td><code>{{ protocolCacheLabel(slice.label) }}</code></td><td>{{ percent(slice.tokenHitRate) }}</td><td>{{ percent(slice.requestHitRate) }}</td><td>{{ percent(slice.affinityReuseRate) }}</td><td>{{ slice.affinityFailovers }}</td></tr><tr v-if="!inspectingCache.cache.protocols.length"><td colspan="5">暂无协议用量</td></tr></tbody></table></section><section><h3>按模型</h3><table><thead><tr><th>模型</th><th>输入 Token</th><th>缓存读取</th><th>Token 命中</th><th>请求命中</th></tr></thead><tbody><tr v-for="slice in inspectingCache.cache.models" :key="slice.label"><td><code>{{ slice.label }}</code></td><td>{{ slice.inputTokens.toLocaleString() }}</td><td>{{ slice.cacheReadTokens.toLocaleString() }}</td><td>{{ percent(slice.tokenHitRate) }}</td><td>{{ percent(slice.requestHitRate) }}</td></tr><tr v-if="!inspectingCache.cache.models.length"><td colspan="5">暂无模型用量</td></tr></tbody></table></section></div></section></div>
    <AppConfirmDialog :open="Boolean(deletingChannel)" title="删除渠道" :message="`删除渠道“${deletingChannel?.name || ''}”？模型映射和分组渠道规则也会一并移除。`" :busy="saving" @close="deletingChannel = null" @confirm="remove" />
    </template>

    <template v-else-if="activeTab === 'groups'">
      <AdminHubGroupsPanel ref="groupPanel" />
    </template>

    <template v-else>
      <AdminHubPlansPanel ref="planPanel" />
    </template>
  </div>
</template>

<style scoped>
.channel-protocol-picker { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.55rem; }
.channel-protocol-picker button { min-height:64px; display:flex; align-items:center; gap:.55rem; padding:.65rem; text-align:left; color:var(--hub-text); border:1px solid var(--hub-line-strong); background:var(--hub-input-bg); }
.channel-protocol-picker button > svg { flex:none; opacity:0; }
.channel-protocol-picker button.active { border-color:var(--hub-accent); background:var(--hub-accent-soft); }
.channel-protocol-picker button.active > svg { opacity:1; color:var(--hub-accent-text); }
.channel-protocol-picker button span { display:grid; gap:.15rem; }
.channel-protocol-picker small { color:var(--hub-text-faint); font-size:.68rem; }
.channel-auth-schemes { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.55rem; margin-top:.65rem; }
.channel-auth-schemes label { min-width:0; display:grid; gap:.35rem; color:var(--hub-text-faint); font-size:.68rem; }
.channel-compat-options { display:grid; gap:.75rem; }
.channel-compatibility { display:flex; flex-wrap:wrap; gap:.45rem; margin-top:.65rem; }
.channel-compatibility span { padding:.35rem .5rem; border:1px solid var(--hub-line); color:var(--hub-text-muted); background:var(--hub-solid-surface); font-size:.68rem; }
.channel-access-mode { display:grid; grid-template-columns:1fr 1fr; gap:.55rem; }
.channel-access-mode label { position:relative; }
.channel-access-mode input { position:absolute; opacity:0; pointer-events:none; }
.channel-access-mode span { min-height:40px; display:grid; place-items:center; border:1px solid var(--hub-line-strong); color:var(--hub-text-muted); background:var(--hub-input-bg); cursor:pointer; }
.channel-access-mode input:checked + span { border-color:var(--hub-accent); color:var(--hub-accent-text); background:var(--hub-accent-soft); }
.channel-grant-title { margin:.8rem 0 .45rem; color:var(--hub-text-muted); font-size:.72rem; font-weight:600; }
.cache-diagnostics { display:grid; gap:1.25rem; padding:1rem; overflow:auto; }
.cache-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border:1px solid var(--hub-line); }
.cache-summary > div { min-width:0; display:grid; gap:.3rem; padding:.8rem; border-right:1px solid var(--hub-line); }
.cache-summary > div:last-child { border-right:0; }
.cache-summary span,.cache-summary small { color:var(--hub-text-faint); font-size:.67rem; }
.cache-summary strong { font:600 1.05rem var(--font-mono); }
.cache-diagnostics section { min-width:0; }
.cache-diagnostics h3 { margin:0 0 .5rem; font-size:.78rem; }
.cache-diagnostics table { width:100%; border-collapse:collapse; font-size:.72rem; }
.cache-diagnostics th,.cache-diagnostics td { padding:.55rem; border-bottom:1px solid var(--hub-line-row); text-align:left; }
.cache-diagnostics th { color:var(--hub-text-faint); font-weight:500; }
@media (max-width:700px) { .channel-protocol-picker,.channel-auth-schemes { grid-template-columns:1fr; } }
@media (max-width:700px) { .cache-summary { grid-template-columns:1fr 1fr; } .cache-summary > div:nth-child(2) { border-right:0; } .cache-summary > div:nth-child(-n+2) { border-bottom:1px solid var(--hub-line); } .cache-diagnostics table { min-width:560px; } }
</style>
