<script setup lang="ts">
import { IconBraces, IconCalendarCheck, IconCheck, IconChecks, IconChevronDown, IconChevronUp, IconCloudDownload, IconCode, IconCopy, IconEdit, IconExternalLink, IconKey, IconPlus, IconRefresh, IconServerBolt, IconTrash, IconWallet, IconX } from '@tabler/icons-vue'
import type { ChannelModelView, ChannelProtocol, ChannelProtocolBindingView, ChannelView, HubKeyView } from '#shared/types/hub'

const { data, refresh } = await useFetch<{ relays: ChannelView[] }>('/api/console/relays')
const { data: keyData, refresh: refreshKeys } = await useFetch<{ keys: HubKeyView[] }>('/api/console/keys')
const toast = useAppToast()
const busy = ref(false)
const discovering = ref(false)
const discoveredModels = ref<string[]>([])
const mappingsExpanded = ref(false)
const testing = ref<string | null>(null)
const testingCandidate = ref<ChannelView | null>(null)
interface RelayTestResult { protocol: ChannelProtocol; endpoint: string; ok: boolean; status: number | null; latencyMs: number; errorCode: string | null; message: string | null; authScheme: 'bearer' | 'x_api_key'; attemptedAuthSchemes: Array<'bearer' | 'x_api_key'>; clientIdentityRejected: boolean; clientIdentityProbed: boolean }
const testReport = ref<{ relayName: string; healthy: boolean; results: RelayTestResult[] } | null>(null)
const syncing = ref<string | null>(null)
const checkingIn = ref<string | null>(null)
const checkingInAll = ref(false)
const deleting = ref<ChannelView | null>(null)
const editing = ref<ChannelView | null>(null)
const showForm = ref(false)
const configuring = ref<ChannelView | null>(null)
const modelRelay = ref<ChannelView | null>(null)
const configMode = ref<'claude' | 'codex'>('claude')
const configModel = ref('')
const generatedKey = ref('')
const selectedKeyId = ref('new')
const error = ref('')
interface RelayBalance { id: string; name: string; quota: number | null; usedQuota: number | null; remaining: number | null; currency: string | null; fetchedAt: number; error?: string }
const balances = ref<Record<string, RelayBalance>>({})
const balanceLoading = ref<string | null>(null)
const balanceRefreshingAll = ref(false)

const protocolOptions: Array<{ id: ChannelProtocol; label: string; detail: string }> = [
  { id: 'anthropic_messages', label: 'Anthropic Messages', detail: 'Claude Code 原生' },
  { id: 'openai_responses', label: 'OpenAI Responses', detail: 'Codex 原生' },
  { id: 'openai_chat', label: 'OpenAI Chat', detail: '通用兼容 / 转换' }
]
const form = reactive({ name: '', baseUrl: '', apiKey: '', protocols: [binding('anthropic_messages')] as ChannelProtocolBindingView[], models: [] as ChannelModelView[], enabled: true, weight: 1, maxConcurrency: 5, timeoutMs: 120000, checkinEnabled: false, checkinToken: '', checkinUserId: '', modelDiscoveryEnabled: true, clientIdentityMode: 'standard' as 'standard' | 'passthrough' })
const checkinCount = computed(() => data.value?.relays.filter(item => item.checkinEnabled && item.checkinConfigured).length || 0)

function binding(protocol: ChannelProtocol): ChannelProtocolBindingView {
  return { protocol, enabled: true, baseUrlOverride: null, authScheme: protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer', apiVersion: protocol === 'anthropic_messages' ? '2023-06-01' : null, probeModel: null, verificationStatus: 'unknown', verifiedAt: null, lastError: null }
}
function emptyModel(): ChannelModelView { return { publicModel: '', upstreamModel: '', enabled: true, endpoints: [] } }
function modelProtocolEnabled(model: ChannelModelView, protocol: ChannelProtocol) {
  return model.protocolBindings?.length
    ? model.protocolBindings.some(binding => binding.protocol === protocol && binding.enabled)
    : Boolean(selectedProtocol(protocol))
}
function toggleModelProtocol(model: ChannelModelView, protocol: ChannelProtocol) {
  const enabledProtocols = form.protocols.map(item => item.protocol)
  const current = model.protocolBindings?.length
    ? model.protocolBindings.map(item => ({ ...item, capabilities: { ...item.capabilities } }))
    : enabledProtocols.map(item => ({ protocol: item, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } }))
  const index = current.findIndex(item => item.protocol === protocol)
  if (index >= 0) current.splice(index, 1)
  else current.push({ protocol, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } })
  model.protocolBindings = current
}
function isDirectModel(model: ChannelModelView) {
  return model.publicModel === model.upstreamModel && !model.endpoints.length && (!model.protocolBindings?.length || model.protocolBindings.every(binding => binding.upstreamModel === model.upstreamModel))
}
function reset() { Object.assign(form, { name: '', baseUrl: '', apiKey: '', protocols: [binding('anthropic_messages')], models: [emptyModel()], enabled: true, weight: 1, maxConcurrency: 5, timeoutMs: 120000, checkinEnabled: false, checkinToken: '', checkinUserId: '', modelDiscoveryEnabled: true, clientIdentityMode: 'standard' }); discoveredModels.value = []; mappingsExpanded.value = false }
function create() { editing.value = null; reset(); error.value = ''; showForm.value = true }
function edit(item: ChannelView) {
  editing.value = item
  const direct = item.models.filter(isDirectModel)
  const mapped = item.models.filter(model => !isDirectModel(model))
  discoveredModels.value = direct.map(model => model.upstreamModel)
  Object.assign(form, { name: item.name, baseUrl: item.baseUrl, apiKey: '', protocols: item.protocols.map(protocol => ({ ...protocol })), models: mapped.length ? mapped.map(model => ({ ...model, endpoints: [...model.endpoints], protocolBindings: model.protocolBindings?.map(protocol => ({ ...protocol, capabilities: { ...protocol.capabilities } })) })) : [emptyModel()], enabled: item.enabled, weight: item.weight, maxConcurrency: item.maxConcurrency, timeoutMs: item.timeoutMs, checkinEnabled: item.checkinEnabled, checkinToken: '', checkinUserId: item.checkinUserId || '', modelDiscoveryEnabled: item.modelDiscoveryEnabled, clientIdentityMode: item.clientIdentityMode })
  mappingsExpanded.value = mapped.length > 0
  error.value = ''; showForm.value = true
}
function toggleProtocol(protocol: ChannelProtocol) {
  const index = form.protocols.findIndex(value => value.protocol === protocol)
  if (index >= 0) form.protocols.splice(index, 1)
  else form.protocols.push(binding(protocol))
}
function selectedProtocol(protocol: ChannelProtocol) { return form.protocols.find(item => item.protocol === protocol) }
function setAuthScheme(protocol: ChannelProtocol, value: unknown) {
  const item = selectedProtocol(protocol)
  if (item) item.authScheme = value === 'x_api_key' ? 'x_api_key' : 'bearer'
}
function setProbeModel(protocol: ChannelProtocol, event: Event) {
  const item = selectedProtocol(protocol)
  if (item) item.probeModel = (event.target as HTMLInputElement).value
}
function body() {
  const protocols = form.protocols.map(protocol => ({ ...protocol, id: undefined }))
  const mappedModels: ChannelModelView[] = form.models.filter(model => model.upstreamModel.trim()).map(model => ({
    ...model,
    publicModel: model.publicModel.trim() || model.upstreamModel.trim(),
    upstreamModel: model.upstreamModel.trim(),
    protocolBindings: protocols.flatMap(item => {
      const existing = model.protocolBindings?.find(protocol => protocol.protocol === item.protocol)
      if (model.protocolBindings?.length && !existing) return []
      return [existing || { protocol: item.protocol, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } }]
    })
  }))
  const discovered = discoveredModels.value.map(upstreamModel => ({ publicModel: upstreamModel, upstreamModel, enabled: true, endpoints: [], protocolBindings: protocols.map(protocol => ({ protocol: protocol.protocol, upstreamModel, enabled: true, capabilities: { streaming: true, tools: true } })) } satisfies ChannelModelView))
  const models = [...new Map([...discovered, ...mappedModels].map(model => [model.publicModel, model])).values()]
  return { ...form, protocols, models }
}
function addModel() { form.models.push(emptyModel()) }
function removeModel(index: number) { form.models.splice(index, 1); if (!form.models.length) form.models.push(emptyModel()) }
const probeModels = computed(() => [...new Set([...discoveredModels.value, ...form.models.map(model => model.upstreamModel.trim()).filter(Boolean)])])
async function discoverModels() {
  if (!form.baseUrl || !form.apiKey && !editing.value) { error.value = '请先填写中转地址和 API Key'; return }
  if (!form.protocols.length) { error.value = '请至少选择一种协议'; return }
  discovering.value = true; error.value = ''
  try {
    const result = await $fetch<{ models: string[] }>('/api/console/relays/models/discover', { method: 'POST', body: { relayId: editing.value?.id, baseUrl: form.baseUrl, apiKey: form.apiKey, protocols: form.protocols, timeoutMs: form.timeoutMs } })
    discoveredModels.value = result.models
    for (const protocol of form.protocols) if (!protocol.probeModel && result.models[0]) protocol.probeModel = result.models[0]
    toast.show(`已获取 ${result.models.length} 个模型`, 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '获取模型失败' }
  finally { discovering.value = false }
}
function announceRelayChange() { if (import.meta.client) window.dispatchEvent(new Event('user-relays-changed')) }
async function save() {
  if (!form.protocols.length) { error.value = '请至少选择一种协议'; return }
  if (form.protocols.some(protocol => !protocol.probeModel?.trim())) { error.value = '请为每个协议指定检测模型'; return }
  busy.value = true; error.value = ''
  try {
    const saved = editing.value
      ? await $fetch<ChannelView>(`/api/console/relays/${editing.value.id}`, { method: 'PATCH', body: body() })
      : await $fetch<ChannelView>('/api/console/relays', { method: 'POST', body: body() })
    showForm.value = false; await refresh(); announceRelayChange(); toast.show(editing.value ? '中转已更新' : `中转已添加，已获取 ${saved.models.filter(model => model.enabled).length} 个模型`, 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '保存失败' }
  finally { busy.value = false }
}
async function test(item: ChannelView) {
  testing.value = item.id
  try { const result = await $fetch<{ healthy: boolean; results: RelayTestResult[] }>(`/api/console/relays/${item.id}/test`, { method: 'POST' }); testReport.value = { relayName: item.name, ...result }; await refresh(); announceRelayChange(); toast.show(result.healthy ? '至少一个协议检测通过' : '协议检测未通过', result.healthy ? 'success' : 'error') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '检测失败', 'error') }
  finally { testing.value = null }
}
function requestTest(item: ChannelView) {
  if (testing.value) {
    const active = data.value?.relays.find(relay => relay.id === testing.value)
    toast.show(`正在检测“${active?.name || '其他中转'}”，完成后可再次操作`, 'info')
    return
  }
  testingCandidate.value = item
}
async function confirmTest() {
  const item = testingCandidate.value
  if (!item) return
  testingCandidate.value = null
  if (testing.value) {
    toast.show('已有协议检测正在执行，请等待完成', 'info')
    return
  }
  await test(item)
}
async function sync(item: ChannelView) {
  syncing.value = item.id
  try { const result = await $fetch<{ discovered: number; added: number; removed: number; reactivated: number }>(`/api/console/relays/${item.id}/models/sync`, { method: 'POST' }); await refresh(); toast.show(`同步 ${result.discovered} 个模型：新增 ${result.added}，移除 ${result.removed}，恢复 ${result.reactivated}`, 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '同步失败', 'error') }
  finally { syncing.value = null }
}
async function checkin(item: ChannelView) {
  checkingIn.value = item.id
  try {
    const result = await $fetch<{ success: boolean; status: string; message: string; awardedQuota: number | null }>(`/api/console/relays/${item.id}/checkin`, { method: 'POST' })
    await refresh()
    toast.show(result.awardedQuota ? `${result.message}，获得 ${result.awardedQuota} 额度` : result.message, result.success ? 'success' : 'error')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '签到失败', 'error')
  } finally { checkingIn.value = null }
}
async function checkinAll() {
  checkingInAll.value = true
  try {
    const result = await $fetch<{ summary: { total: number; success: number; failed: number } }>('/api/console/relays/checkin-all', { method: 'POST' })
    await refresh()
    toast.show(`签到完成：${result.summary.success}/${result.summary.total} 成功`, result.summary.failed ? 'error' : 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '一键签到失败', 'error')
  } finally { checkingInAll.value = false }
}
async function remove() {
  if (!deleting.value) return
  busy.value = true
  try { await $fetch(`/api/console/relays/${deleting.value.id}`, { method: 'DELETE' }); deleting.value = null; await Promise.all([refresh(), refreshKeys()]); announceRelayChange(); toast.show('中转已删除', 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '删除失败', 'error') }
  finally { busy.value = false }
}
function openConfig(item: ChannelView) { configuring.value = item; configModel.value = item.models.find(model => model.enabled)?.publicModel || ''; configMode.value = item.protocols.some(protocol => protocol.protocol === 'anthropic_messages' || protocol.protocol === 'openai_chat') ? 'claude' : 'codex'; selectedKeyId.value = keyData.value?.keys.find(key => key.routeMode === 'private_only' && (!key.channelIds.length || key.channelIds.includes(item.id)))?.id || 'new'; generatedKey.value = ''; error.value = '' }
function openModels(item: ChannelView) { modelRelay.value = item }
async function createDedicatedKey() {
  if (!configuring.value || !configModel.value) { error.value = '请先选择模型'; return }
  busy.value = true; error.value = ''
  try {
    const result = await $fetch<{ key: string }>('/api/console/keys', { method: 'POST', body: { name: `${configuring.value.name} · ${configMode.value === 'claude' ? 'Claude Code' : 'Codex'}`, note: '由中转配置生成器创建', routeMode: 'private_only', channelIds: [] } })
    generatedKey.value = result.key; await refreshKeys()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '创建专用 Key 失败' }
  finally { busy.value = false }
}
async function useExistingKey() {
  if (!configuring.value || selectedKeyId.value === 'new') return createDedicatedKey()
  busy.value = true; error.value = ''
  try {
    await $fetch(`/api/console/keys/${selectedKeyId.value}/channels`, { method: 'PUT', body: { routeMode: 'private_only', channelIds: [] } })
    generatedKey.value = (await $fetch<{ key: string }>(`/api/console/keys/${selectedKeyId.value}/reveal`, { method: 'POST' })).key
    await refreshKeys()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '绑定或读取 Key 失败' }
  finally { busy.value = false }
}
const configText = computed(() => {
  if (!configuring.value || !configModel.value) return ''
  const key = generatedKey.value || 'YOUR_HUB_KEY'
  if (configMode.value === 'claude') return JSON.stringify({ env: { ANTHROPIC_BASE_URL: location.origin, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: configModel.value } }, null, 2)
  const wireApi = configuring.value.protocols.some(protocol => protocol.protocol === 'openai_responses') ? 'responses' : 'chat'
  return `model_provider = "Zephyr"\nmodel = "${configModel.value}"\n\n[model_providers.Zephyr]\nname = "Zephyr Hub"\nbase_url = "${location.origin}/v1"\nwire_api = "${wireApi}"\nrequires_openai_auth = false\nenv_key = "ZEPHYR_HUB_KEY"\n\n# ZEPHYR_HUB_KEY=${key}`
})
async function copyConfig() { await navigator.clipboard.writeText(configText.value); toast.show('配置已复制', 'success') }
const protocolLabel = (protocol: ChannelProtocol) => ({ anthropic_messages: 'Messages', openai_responses: 'Responses', openai_chat: 'Chat' })[protocol]
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value) : '未检测'
const checkedInToday = (item: ChannelView) => Boolean(item.lastCheckinAt && ['success', 'already'].includes(item.lastCheckinStatus || '') && new Date(item.lastCheckinAt).toDateString() === new Date().toDateString())
const formatBalance = (value: number | null, currency: string | null) => value === null ? '未知' : `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''}${value.toFixed(2)}`
const balanceValue = (id: string) => balances.value[id] || { quota: null, usedQuota: null, remaining: null, currency: null, fetchedAt: 0 }
async function refreshBalance(item: ChannelView) {
  balanceLoading.value = item.id
  try { balances.value[item.id] = await $fetch<RelayBalance>(`/api/console/relays/${item.id}/balance`, { method: 'POST' }) }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; balances.value[item.id] = { id: item.id, name: item.name, quota: null, usedQuota: null, remaining: null, currency: null, fetchedAt: Date.now(), error: failure.data?.message || failure.message || '余额查询失败' } }
  finally { balanceLoading.value = null }
}
async function refreshBalances() {
  const relays = data.value?.relays || []
  if (!relays.length) return
  balanceRefreshingAll.value = true
  try { await Promise.all(relays.map(item => refreshBalance(item))) } finally { balanceRefreshingAll.value = false }
}
onMounted(() => { void refreshBalances() })
</script>

<template>
  <div class="admin-page relay-page">
    <header class="resource-panel-header"><div><span class="admin-kicker">PRIVATE RELAYS</span><h2>我的中转</h2><p>管理仅供自己使用的模型服务，余额直接展示。</p></div><div class="resource-panel-actions"><button class="button button--quiet button--small" :disabled="balanceRefreshingAll" @click="refreshBalances"><IconWallet :size="15" />{{ balanceRefreshingAll ? '查询中' : '刷新余额' }}</button><button class="button button--secondary" :disabled="!checkinCount || checkingInAll" @click="checkinAll"><IconChecks :size="17" />{{ checkingInAll ? '签到中' : '一键签到' }}</button><button class="button button--primary" @click="create"><IconPlus :size="17" />添加中转</button></div></header>
    <section class="relay-ledger">
      <article v-for="item in data?.relays || []" :key="item.id" class="relay-row">
        <div class="relay-identity"><span><IconServerBolt :size="19" /></span><div><strong>{{ item.name }}</strong><a class="relay-url" :href="item.baseUrl" target="_blank" rel="noopener noreferrer" :title="`打开 ${item.baseUrl}`"><IconExternalLink :size="12" />{{ item.baseUrl }}</a><small>仅自己 · {{ item.models.filter(model => model.enabled).length }} 个模型</small></div></div>
        <div class="relay-protocols"><span v-for="protocol in item.protocols" :key="protocol.id || protocol.protocol" :data-status="protocol.verificationStatus"><i />{{ protocolLabel(protocol.protocol) }}</span></div>
        <div class="relay-health"><strong>{{ item.healthStatus === 'healthy' ? '可用' : item.healthStatus === 'unhealthy' ? '需处理' : '待检测' }}</strong><small>{{ date(item.lastHealthCheckAt) }}</small><em v-if="item.lastHealthError" :title="item.lastHealthError">{{ item.lastHealthError }}</em></div>
        <div class="relay-balance"><template v-if="balances[item.id]?.error"><strong>查询失败</strong><small :title="balances[item.id]?.error">{{ balances[item.id]?.error }}</small></template><template v-else-if="balances[item.id]"><strong>{{ formatBalance(balanceValue(item.id).remaining, balanceValue(item.id).currency) }}</strong><small>历史消耗 {{ formatBalance(balanceValue(item.id).usedQuota, balanceValue(item.id).currency) }}</small></template><template v-else><strong>余额待查</strong><small>{{ item.checkinConfigured ? '点击刷新余额' : '需配置访问令牌' }}</small></template></div>
        <div class="table-actions"><button class="button button--quiet button--small relay-model-button" :disabled="!item.models.length" @click="openModels(item)"><IconBraces :size="14" />查看模型 <span>{{ item.models.filter(model => model.enabled).length }}</span></button><button class="icon-button" title="刷新余额" :aria-label="`${item.name} 刷新余额`" :disabled="balanceLoading === item.id || !item.checkinConfigured" @click="refreshBalance(item)"><IconWallet :size="16" /></button><button v-if="item.checkinEnabled && item.checkinConfigured" class="icon-button" :class="{ 'is-complete': checkedInToday(item) }" :title="checkedInToday(item) ? '今日已签到' : '签到'" :aria-label="`${item.name} ${checkedInToday(item) ? '今日已签到' : '签到'}`" :disabled="checkingIn === item.id || checkedInToday(item)" @click="checkin(item)"><IconCalendarCheck :size="17" /></button><button class="icon-button" :title="testing === item.id ? '协议检测正在执行' : '协议检测'" :aria-label="testing === item.id ? `${item.name} 协议检测正在执行` : `${item.name} 协议检测`" :aria-busy="testing === item.id" @click="requestTest(item)"><IconRefresh :class="{ 'is-spinning': testing === item.id }" :size="17" /></button><button class="icon-button" title="同步模型" aria-label="同步模型" :disabled="syncing === item.id" @click="sync(item)"><IconCloudDownload :size="17" /></button><button class="icon-button" title="生成客户端配置" aria-label="生成客户端配置" @click="openConfig(item)"><IconCode :size="17" /></button><button class="icon-button" title="编辑" aria-label="编辑中转" @click="edit(item)"><IconEdit :size="17" /></button><button class="icon-button danger" title="删除" aria-label="删除中转" @click="deleting = item"><IconTrash :size="17" /></button></div>
      </article>
      <div v-if="!data?.relays.length" class="admin-empty relay-empty"><IconServerBolt :size="26" /><strong>还没有私有中转</strong><p>添加一个支持 Messages、Responses 或 Chat 的站点。</p><button class="button button--primary button--small" @click="create">添加第一个中转</button></div>
    </section>

    <AppDrawer :open="showForm" kicker="PRIVATE RELAY" :title="editing ? '编辑中转' : '添加中转'" @close="showForm = false"><form class="admin-form" @submit.prevent="save">
      <div class="form-grid"><label><span>名称 *</span><input v-model="form.name" required placeholder="例如：我的多协议站"></label><label><span>Base URL *</span><input v-model="form.baseUrl" type="url" required placeholder="https://relay.example.com"></label></div>
      <label><span>上游 API Key {{ editing ? '（留空保持不变）' : '*' }}</span><span class="relay-key-input"><input v-model="form.apiKey" type="password" :required="!editing" autocomplete="off"><button type="button" class="button button--secondary button--small" :disabled="discovering || !form.baseUrl || (!form.apiKey && !editing)" @click="discoverModels"><IconCloudDownload :size="15" />{{ discovering ? '获取中' : '获取模型' }}</button></span></label>
      <section class="form-section relay-checkin"><header><div><h3>NewAPI 签到</h3><span>{{ editing?.checkinConfigured ? '访问令牌已保存' : '可选' }}</span></div><label class="switch"><input v-model="form.checkinEnabled" type="checkbox"><span />启用签到</label></header><div v-if="form.checkinEnabled" class="form-grid"><label><span>控制台访问令牌 {{ editing?.checkinConfigured ? '（留空保持不变）' : '*' }}</span><input v-model="form.checkinToken" type="password" :required="!editing?.checkinConfigured" autocomplete="off" placeholder="NewAPI access token"></label><label><span>旧版用户 ID（可选）</span><input v-model="form.checkinUserId" autocomplete="off" placeholder="用于 New-Api-User"></label></div></section>
      <section class="form-section"><header><div><h3>上游协议</h3><span>每个协议使用指定模型检测，认证失败时自动补测另一种认证</span></div></header><datalist id="relay-discovered-models"><option v-for="model in probeModels" :key="model" :value="model" /></datalist><div class="protocol-picker"><div v-for="option in protocolOptions" :key="option.id" class="protocol-option" :class="{ active: selectedProtocol(option.id) }"><button type="button" @click="toggleProtocol(option.id)"><IconCheck :size="15" /><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button><div v-if="selectedProtocol(option.id)" class="protocol-option__settings"><label><span>默认认证</span><AppSelect :model-value="selectedProtocol(option.id)?.authScheme" @update:model-value="setAuthScheme(option.id, $event)"><option value="bearer">Bearer</option><option value="x_api_key">x-api-key</option></AppSelect></label><label><span>检测模型 *</span><input :value="selectedProtocol(option.id)?.probeModel || ''" list="relay-discovered-models" required placeholder="选择或输入模型" @input="setProbeModel(option.id, $event)"></label></div></div></div></section>
      <section class="form-section relay-compat-settings"><header><div><h3>兼容设置</h3><span>客户端限定站点可关闭模型发现</span></div></header><label class="switch"><input v-model="form.modelDiscoveryEnabled" type="checkbox"><span />保存和健康检查时自动读取模型</label><label class="switch"><input v-model="form.clientIdentityMode" type="checkbox" true-value="passthrough" false-value="standard"><span />透传真实 Claude Code / Codex 客户端身份</label></section>
      <section v-if="discoveredModels.length" class="form-section relay-discovered"><header><div><h3>已获取模型</h3><span>{{ discoveredModels.length }} 个模型将直接启用</span></div><button type="button" class="button button--quiet button--small" @click="discoveredModels = []">清空</button></header><div class="relay-model-badges"><span v-for="model in discoveredModels" :key="model" :title="model">{{ model }}</span></div></section>
      <section class="form-section relay-mappings"><header><button type="button" class="relay-section-toggle" :aria-expanded="mappingsExpanded" @click="mappingsExpanded = !mappingsExpanded"><component :is="mappingsExpanded ? IconChevronUp : IconChevronDown" :size="16" /><span><strong>模型映射</strong><small>仅在需要修改 Hub 对外模型名或协议绑定时配置</small></span></button><button v-if="mappingsExpanded" type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" />添加映射</button></header><div v-if="mappingsExpanded" class="relay-model-list"><div v-for="(model, index) in form.models" :key="model.id || index" class="relay-model-entry"><div class="relay-model-row"><input v-model="model.publicModel" placeholder="Hub 模型名（留空自动同名）"><span>→</span><input v-model="model.upstreamModel" placeholder="上游模型名"><button type="button" class="icon-button danger" title="移除模型" aria-label="移除模型" @click="removeModel(index)"><IconX :size="15" /></button></div><div class="relay-model-protocols"><button v-for="protocol in form.protocols" :key="protocol.protocol" type="button" :class="{ active: modelProtocolEnabled(model, protocol.protocol) }" @click="toggleModelProtocol(model, protocol.protocol)"><IconCheck :size="12" />{{ protocolLabel(protocol.protocol) }}</button></div></div></div></section>
      <div class="form-grid relay-settings-grid"><label><span>权重</span><input v-model.number="form.weight" type="number" min="1"></label><label><span>最大并发</span><input v-model.number="form.maxConcurrency" type="number" min="1"></label><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="1000"></label></div>
      <p v-if="error" class="form-error">{{ error }}</p><footer><label class="switch"><input v-model="form.enabled" type="checkbox"><span />启用中转</label><div><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '保存中' : '保存中转' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer v-if="configuring" :open="Boolean(configuring)" kicker="CLIENT SETUP" :title="`连接 ${configuring.name}`" @close="configuring = null"><div class="config-builder">
      <div class="config-tabs"><button :class="{ active: configMode === 'claude' }" :disabled="!configuring.protocols.some(item => item.protocol === 'anthropic_messages' || item.protocol === 'openai_chat')" @click="configMode = 'claude'">Claude Code</button><button :class="{ active: configMode === 'codex' }" :disabled="!configuring.protocols.some(item => item.protocol === 'openai_responses' || item.protocol === 'openai_chat')" @click="configMode = 'codex'">Codex</button></div>
      <label><span>模型</span><AppSelect v-model="configModel"><option v-for="model in configuring.models.filter(item => item.enabled)" :key="model.id || model.publicModel" :value="model.publicModel">{{ model.publicModel }}</option></AppSelect></label>
      <div class="key-choice"><label><span>Hub Key</span><AppSelect v-model="selectedKeyId"><option value="new">新建专用 Key</option><option v-for="key in keyData?.keys.filter(item => item.status === 'active') || []" :key="key.id" :value="key.id">{{ key.name }} · {{ key.maskedKey }}</option></AppSelect></label></div>
      <div class="key-provision"><div><IconKey :size="18" /><span><strong>专用 Hub Key</strong><small>按故障转移顺序使用所有支持该模型的私有中转。</small></span></div><button class="button button--secondary button--small" :disabled="busy || !configModel" @click="useExistingKey">{{ generatedKey ? '重新绑定' : selectedKeyId === 'new' ? '生成专用 Key' : '绑定并读取 Key' }}</button></div>
      <pre><code>{{ configText }}</code></pre><button class="button button--primary" :disabled="!configText" @click="copyConfig"><IconCopy :size="16" />复制配置</button><p v-if="error" class="form-error">{{ error }}</p>
    </div></AppDrawer>
    <AppDrawer v-if="modelRelay" :open="Boolean(modelRelay)" wide kicker="RELAY MODELS" :title="`${modelRelay.name} · 模型`" @close="modelRelay = null"><section class="relay-model-drawer"><header><div><strong>{{ modelRelay.baseUrl }}</strong><small>{{ modelRelay.models.length }} 个模型 · {{ modelRelay.models.filter(model => model.enabled).length }} 个已启用</small></div><a class="button button--quiet button--small" :href="modelRelay.baseUrl" target="_blank" rel="noopener noreferrer"><IconExternalLink :size="14" />打开官网</a></header><div v-if="modelRelay.models.length" class="relay-model-catalog"><article v-for="model in modelRelay.models" :key="model.id || model.publicModel" :data-disabled="!model.enabled"><div><strong>{{ model.publicModel }}</strong><small v-if="model.upstreamModel !== model.publicModel">上游：{{ model.upstreamModel }}</small></div><div class="relay-model-meta"><span>{{ model.enabled ? '已启用' : '已停用' }}</span><code>{{ model.endpoints.length ? model.endpoints.map(endpoint => endpoint.replace('/v1/', '')).join(' · ') : '按协议支持' }}</code></div></article></div><div v-else class="admin-empty">该中转暂无模型</div></section></AppDrawer>
    <AppConfirmDialog :open="Boolean(testingCandidate)" title="执行协议检测" :message="`将对“${testingCandidate?.name || ''}”的每个协议发送最小推理请求；认证失败时会自动补测另一种认证，每个协议最多两次，上游可能计费。是否继续？`" confirm-label="开始检测" confirm-tone="primary" busy-label="检测中" @close="testingCandidate = null" @confirm="confirmTest" />
    <AppDrawer v-if="testReport" :open="Boolean(testReport)" kicker="PROTOCOL DIAGNOSTICS" :title="testReport.relayName" @close="testReport = null"><div class="relay-test-results"><article v-for="result in testReport.results" :key="result.protocol" :data-ok="result.ok"><div><strong>{{ protocolLabel(result.protocol) }}</strong><span>{{ result.ok ? '通过' : '失败' }} · {{ result.latencyMs }} ms</span></div><code>{{ result.endpoint }}</code><small>采用 {{ result.authScheme === 'bearer' ? 'Bearer' : 'x-api-key' }}<template v-if="result.attemptedAuthSchemes.length > 1"> · 已自动测试 Bearer 与 x-api-key</template><template v-if="result.clientIdentityProbed"> · 使用兼容客户端身份</template></small><p v-if="result.clientIdentityRejected">上游仍拒绝兼容客户端身份，请确认该协议和模型确实受上游支持。</p><p v-else-if="result.errorCode || result.message"><b v-if="result.errorCode">{{ result.errorCode }}</b>{{ result.message }}</p></article></div></AppDrawer>
    <AppConfirmDialog :open="Boolean(deleting)" title="删除中转" :message="`删除“${deleting?.name || ''}”后，绑定它的专用 Key 将不再有可用渠道。`" :busy="busy" @close="deleting = null" @confirm="remove" />
  </div>
</template>

<style scoped>
.relay-page { width:100%; }
.resource-panel-header { min-height:72px; margin-bottom:1rem; display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
.resource-panel-header h2 { margin-top:.25rem; font-size:1.25rem; }
.resource-panel-header p { margin-top:.35rem; color:var(--text-muted); font-size:.78rem; }
.resource-panel-actions { display:flex; align-items:center; gap:.55rem; }
.relay-ledger { display:grid; gap:.65rem; }
.relay-row { min-height:96px; display:grid; grid-template-columns:minmax(220px,1.15fr) minmax(170px,.8fr) minmax(120px,.55fr) minmax(150px,.75fr) auto; gap:1rem; align-items:center; padding:1rem; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface); }
.relay-balance { min-width:0; display:grid; gap:.2rem; }
.relay-balance strong { color:var(--hub-accent); font-family:var(--font-mono); font-size:.86rem; }
.relay-balance small { overflow:hidden; color:var(--hub-text-faint); font-size:.64rem; text-overflow:ellipsis; white-space:nowrap; }
.relay-identity { min-width:0; display:flex; align-items:center; gap:.75rem; }
.relay-identity > span { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--line-strong); color:var(--accent); background:var(--surface-soft); }
.relay-identity > div,.relay-health { min-width:0; display:grid; gap:.2rem; }
.relay-identity code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); font-size:.72rem; }
.relay-url { min-width:0; display:flex; align-items:center; gap:.25rem; overflow:hidden; color:var(--accent); font: .72rem/1.3 var(--font-mono); text-decoration:none; text-overflow:ellipsis; white-space:nowrap; }
.relay-url:hover { text-decoration:underline; }
.relay-identity small,.relay-health small { color:var(--text-muted); font-size:.72rem; }
.relay-protocols { display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-protocols span { display:inline-flex; align-items:center; gap:.35rem; min-height:28px; padding:0 .55rem; border:1px solid var(--line-subtle); border-radius:4px; font-size:.7rem; }
.relay-protocols i { width:6px; height:6px; border-radius:50%; background:var(--text-muted); }
.relay-protocols span[data-status="verified"] i { background:#1a8b62; }
.relay-protocols span[data-status="failed"] i { background:#c5483d; }
.relay-health em { max-width:260px; white-space:pre-wrap; overflow-wrap:anywhere; color:#b42318; font-size:.68rem; line-height:1.45; font-style:normal; }
.table-actions .is-complete { color:#1a8b62; }
.relay-model-button { flex:none; gap:.3rem; white-space:nowrap; }
.relay-model-button span { font-variant-numeric:tabular-nums; }
.relay-checkin > header { align-items:center; }
.relay-empty { min-height:260px; display:grid; place-items:center; align-content:center; gap:.55rem; text-align:center; }
.relay-empty p { margin:0; color:var(--text-muted); }
.protocol-picker { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.55rem; }
.protocol-option { min-width:0; border:1px solid var(--line-strong); background:var(--surface-soft); }
.protocol-option > button { width:100%; min-height:64px; display:flex; align-items:center; gap:.55rem; padding:.65rem; text-align:left; color:var(--text); border:0; background:transparent; }
.protocol-option > button > svg { flex:none; opacity:0; }
.protocol-option.active { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 8%,var(--surface)); }
.protocol-option.active > button > svg { opacity:1; color:var(--accent); }
.protocol-option > button span { display:grid; gap:.15rem; }
.protocol-option__settings { padding:.55rem .65rem; border-top:1px solid var(--line-subtle); display:grid; gap:.55rem; }
.protocol-option__settings label { display:grid; gap:.35rem; color:var(--text-muted); font-size:.68rem; }
.relay-compat-settings { display:grid; gap:.75rem; }
.protocol-picker small { color:var(--text-muted); font-size:.68rem; }
.relay-key-input { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.5rem; }
.relay-key-input .button { min-width:7.2rem; }
.relay-discovered { gap:.65rem; }
.relay-model-badges { max-height:8rem; overflow:auto; display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-model-badges span { max-width:100%; padding:.22rem .45rem; overflow:hidden; border:1px solid var(--line-subtle); border-radius:3px; color:var(--text-muted); background:var(--surface-soft); font: .65rem/1.35 var(--font-mono); text-overflow:ellipsis; white-space:nowrap; }
.relay-mappings > header { min-height:2.25rem; }
.relay-section-toggle { min-width:0; padding:0; border:0; display:flex; align-items:center; gap:.5rem; color:var(--text); background:transparent; text-align:left; }
.relay-section-toggle > span { min-width:0; display:grid; gap:.12rem; }
.relay-section-toggle strong { font-size:.78rem; }
.relay-section-toggle small { color:var(--text-muted); font-size:.68rem; font-weight:400; }
.relay-model-list { display:grid; gap:.5rem; }
.relay-model-entry { display:grid; gap:.4rem; padding:.55rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.relay-model-row { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto; gap:.5rem; align-items:center; }
.relay-model-row > span { color:var(--text-muted); }
.relay-model-protocols { display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-model-protocols button { min-height:28px; padding:0 .5rem; border:1px solid var(--line-strong); color:var(--text-muted); background:var(--surface); font-size:.66rem; }
.relay-model-protocols button svg { opacity:0; }
.relay-model-protocols button.active { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb,var(--accent) 7%,var(--surface)); }
.relay-model-protocols button.active svg { opacity:1; }
.relay-settings-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
.config-builder { display:grid; gap:1rem; padding:1.1rem; }
.config-builder > label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.75rem; }
.config-tabs { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--line-strong); }
.config-tabs button { min-height:38px; border:0; background:transparent; color:var(--text-muted); }
.config-tabs button.active { color:var(--text); background:var(--surface-soft); box-shadow:inset 0 -2px var(--accent); }
.key-choice { display:grid; grid-template-columns:1fr 1fr; gap:.65rem; }
.key-choice label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.75rem; }
.key-provision { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.75rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.key-provision > div { display:flex; align-items:center; gap:.6rem; }
.key-provision span { display:grid; gap:.15rem; }
.key-provision small { color:var(--text-muted); font-size:.7rem; }
.config-builder pre { min-height:190px; max-height:320px; overflow:auto; margin:0; padding:1rem; border:1px solid var(--line-strong); background:#111714; color:#dce8e0; font:12px/1.65 var(--font-mono); }
.relay-test-results { display:grid; gap:.65rem; padding:1rem; }
.relay-test-results article { display:grid; gap:.45rem; padding:.8rem; border:1px solid #efb9b4; background:#fff7f6; }
.relay-test-results article[data-ok="true"] { border-color:#a8d9c6; background:#f3fbf7; }
.relay-test-results article > div { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.relay-test-results article span,.relay-test-results code { color:var(--text-muted); font-size:.72rem; }
.relay-test-results code,.relay-test-results p { overflow-wrap:anywhere; white-space:pre-wrap; }
.relay-test-results p { display:grid; gap:.25rem; margin:0; color:#9f2f27; font-size:.75rem; line-height:1.5; }
.relay-test-results b { font-family:var(--font-mono); }
.relay-model-drawer { display:grid; gap:1rem; }
.relay-model-drawer > header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; padding:.8rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.relay-model-drawer > header > div { min-width:0; display:grid; gap:.25rem; }
.relay-model-drawer > header strong { overflow:hidden; color:var(--text); font: .72rem/1.4 var(--font-mono); text-overflow:ellipsis; white-space:nowrap; }
.relay-model-drawer > header small { color:var(--text-muted); font-size:.7rem; }
.relay-model-catalog { display:grid; gap:.45rem; }
.relay-model-catalog article { display:flex; align-items:center; justify-content:space-between; gap:1rem; min-width:0; padding:.7rem .8rem; border:1px solid var(--line-subtle); background:var(--surface); }
.relay-model-catalog article[data-disabled="true"] { opacity:.58; }
.relay-model-catalog article > div:first-child { min-width:0; display:grid; gap:.2rem; }
.relay-model-catalog strong { overflow:hidden; font-size:.76rem; text-overflow:ellipsis; white-space:nowrap; }
.relay-model-catalog small,.relay-model-meta { color:var(--text-muted); font-size:.66rem; }
.relay-model-meta { flex:none; display:grid; justify-items:end; gap:.2rem; text-align:right; }
.relay-model-meta code { max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:900px) { .relay-row { grid-template-columns:1fr auto; } .relay-protocols,.relay-health,.relay-balance { grid-column:1 / -1; } }
@media (max-width:640px) { .resource-panel-header { align-items:stretch; flex-direction:column; } .resource-panel-actions { width:100%; flex-wrap:wrap; } .resource-panel-actions .button { flex:1 1 auto; } .protocol-picker,.key-choice,.relay-settings-grid,.relay-key-input { grid-template-columns:1fr; } .relay-row { grid-template-columns:1fr; } .relay-row > .table-actions { justify-content:flex-end; flex-wrap:wrap; } .relay-model-row { grid-template-columns:1fr auto; } .relay-model-row > span { display:none; } .key-provision { align-items:flex-start; flex-direction:column; } .relay-model-catalog article { align-items:flex-start; flex-direction:column; gap:.45rem; } .relay-model-meta { justify-items:start; text-align:left; } .relay-model-meta code { max-width:100%; } }
</style>
