<script setup lang="ts">
import { IconCheck, IconCloudDownload, IconCode, IconCopy, IconEdit, IconKey, IconPlus, IconRefresh, IconServerBolt, IconTrash, IconX } from '@tabler/icons-vue'
import type { ChannelModelView, ChannelProtocol, ChannelProtocolBindingView, ChannelView, HubKeyView } from '#shared/types/hub'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '我的中转 | Zephyr Hub' })

const { data, refresh } = await useFetch<{ relays: ChannelView[] }>('/api/console/relays')
const { data: keyData, refresh: refreshKeys } = await useFetch<{ keys: HubKeyView[] }>('/api/console/keys')
const toast = useAppToast()
const busy = ref(false)
const testing = ref<string | null>(null)
const testingCandidate = ref<ChannelView | null>(null)
const syncing = ref<string | null>(null)
const deleting = ref<ChannelView | null>(null)
const editing = ref<ChannelView | null>(null)
const showForm = ref(false)
const configuring = ref<ChannelView | null>(null)
const configMode = ref<'claude' | 'codex'>('claude')
const configModel = ref('')
const generatedKey = ref('')
const selectedKeyId = ref('new')
const keyPassword = ref('')
const error = ref('')

const protocolOptions: Array<{ id: ChannelProtocol; label: string; detail: string }> = [
  { id: 'anthropic_messages', label: 'Anthropic Messages', detail: 'Claude Code 原生' },
  { id: 'openai_responses', label: 'OpenAI Responses', detail: 'Codex 原生' },
  { id: 'openai_chat', label: 'OpenAI Chat', detail: '通用兼容 / 转换' }
]
const form = reactive({ name: '', baseUrl: '', apiKey: '', protocols: ['anthropic_messages'] as ChannelProtocol[], models: [] as ChannelModelView[], enabled: true, priority: 100, weight: 1, maxConcurrency: 5, timeoutMs: 120000 })

function binding(protocol: ChannelProtocol): ChannelProtocolBindingView {
  return { protocol, enabled: true, baseUrlOverride: null, authScheme: protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer', apiVersion: protocol === 'anthropic_messages' ? '2023-06-01' : null, verificationStatus: 'unknown', verifiedAt: null, lastError: null }
}
function emptyModel(): ChannelModelView { return { publicModel: '', upstreamModel: '', enabled: true, endpoints: [] } }
function reset() { Object.assign(form, { name: '', baseUrl: '', apiKey: '', protocols: ['anthropic_messages'], models: [emptyModel()], enabled: true, priority: 100, weight: 1, maxConcurrency: 5, timeoutMs: 120000 }) }
function create() { editing.value = null; reset(); error.value = ''; showForm.value = true }
function edit(item: ChannelView) {
  editing.value = item
  Object.assign(form, { name: item.name, baseUrl: item.baseUrl, apiKey: '', protocols: item.protocols.map(protocol => protocol.protocol), models: item.models.length ? item.models.map(model => ({ ...model, endpoints: [...model.endpoints], protocolBindings: model.protocolBindings?.map(protocol => ({ ...protocol, capabilities: { ...protocol.capabilities } })) })) : [emptyModel()], enabled: item.enabled, priority: item.priority, weight: item.weight, maxConcurrency: item.maxConcurrency, timeoutMs: item.timeoutMs })
  error.value = ''; showForm.value = true
}
function toggleProtocol(protocol: ChannelProtocol) {
  form.protocols = form.protocols.includes(protocol) ? form.protocols.filter(value => value !== protocol) : [...form.protocols, protocol]
}
function body() {
  const protocols = form.protocols.map(binding)
  const models: ChannelModelView[] = form.models.filter(model => model.upstreamModel.trim()).map(model => ({
    ...model,
    publicModel: model.publicModel.trim() || model.upstreamModel.trim(),
    upstreamModel: model.upstreamModel.trim(),
    protocolBindings: protocols.map(item => {
      const existing = model.protocolBindings?.find(protocol => protocol.protocol === item.protocol)
      return existing || { protocol: item.protocol, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } }
    })
  }))
  return { ...form, protocols, models }
}
function addModel() { form.models.push(emptyModel()) }
function removeModel(index: number) { form.models.splice(index, 1); if (!form.models.length) form.models.push(emptyModel()) }
async function save() {
  if (!form.protocols.length) { error.value = '请至少选择一种协议'; return }
  busy.value = true; error.value = ''
  try {
    if (editing.value) await $fetch(`/api/console/relays/${editing.value.id}`, { method: 'PATCH', body: body() })
    else await $fetch('/api/console/relays', { method: 'POST', body: body() })
    showForm.value = false; await refresh(); toast.show(editing.value ? '中转已更新' : '中转已添加', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '保存失败' }
  finally { busy.value = false }
}
async function test(item: ChannelView) {
  testing.value = item.id
  try { const result = await $fetch<{ healthy: boolean }>(`/api/console/relays/${item.id}/test`, { method: 'POST' }); await refresh(); toast.show(result.healthy ? '协议检测通过' : '协议检测未通过', result.healthy ? 'success' : 'error') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '检测失败', 'error') }
  finally { testing.value = null }
}
async function confirmTest() {
  const item = testingCandidate.value
  if (!item) return
  try { await test(item) } finally { testingCandidate.value = null }
}
async function sync(item: ChannelView) {
  syncing.value = item.id
  try { const result = await $fetch<{ discovered: number; added: number }>(`/api/console/relays/${item.id}/models/sync`, { method: 'POST' }); await refresh(); toast.show(`读取 ${result.discovered} 个模型，新增 ${result.added} 个`, 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '同步失败', 'error') }
  finally { syncing.value = null }
}
async function remove() {
  if (!deleting.value) return
  busy.value = true
  try { await $fetch(`/api/console/relays/${deleting.value.id}`, { method: 'DELETE' }); deleting.value = null; await Promise.all([refresh(), refreshKeys()]); toast.show('中转已删除', 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '删除失败', 'error') }
  finally { busy.value = false }
}
function openConfig(item: ChannelView) { configuring.value = item; configModel.value = item.models[0]?.publicModel || ''; configMode.value = item.protocols.some(protocol => protocol.protocol === 'anthropic_messages' || protocol.protocol === 'openai_chat') ? 'claude' : 'codex'; selectedKeyId.value = keyData.value?.keys.find(key => key.routeMode === 'private_only' && key.channelIds.includes(item.id))?.id || 'new'; generatedKey.value = ''; keyPassword.value = ''; error.value = '' }
async function createDedicatedKey() {
  if (!configuring.value || !configModel.value) { error.value = '请先选择模型'; return }
  busy.value = true; error.value = ''
  try {
    const result = await $fetch<{ key: string }>('/api/console/keys', { method: 'POST', body: { name: `${configuring.value.name} · ${configMode.value === 'claude' ? 'Claude Code' : 'Codex'}`, note: '由中转配置生成器创建', routeMode: 'private_only', channelIds: [configuring.value.id] } })
    generatedKey.value = result.key; await refreshKeys()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '创建专用 Key 失败' }
  finally { busy.value = false }
}
async function useExistingKey() {
  if (!configuring.value || selectedKeyId.value === 'new') return createDedicatedKey()
  if (!keyPassword.value) { error.value = '使用已有 Key 时请输入当前密码'; return }
  busy.value = true; error.value = ''
  try {
    await $fetch(`/api/console/keys/${selectedKeyId.value}/channels`, { method: 'PUT', body: { routeMode: 'private_only', channelIds: [configuring.value.id] } })
    generatedKey.value = (await $fetch<{ key: string }>(`/api/console/keys/${selectedKeyId.value}/reveal`, { method: 'POST', body: { password: keyPassword.value } })).key
    await refreshKeys()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '绑定或读取 Key 失败' }
  finally { busy.value = false }
}
const configText = computed(() => {
  if (!configuring.value || !configModel.value) return ''
  const key = generatedKey.value || 'YOUR_HUB_KEY'
  if (configMode.value === 'claude') return JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${location.origin}/anthropic`, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: configModel.value } }, null, 2)
  return `model_provider = "Zephyr"\nmodel = "${configModel.value}"\n\n[model_providers.Zephyr]\nname = "Zephyr Hub"\nbase_url = "${location.origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "ZEPHYR_HUB_KEY"\n\n# ZEPHYR_HUB_KEY=${key}`
})
async function copyConfig() { await navigator.clipboard.writeText(configText.value); toast.show('配置已复制', 'success') }
const protocolLabel = (protocol: ChannelProtocol) => ({ anthropic_messages: 'Messages', openai_responses: 'Responses', openai_chat: 'Chat' })[protocol]
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value) : '未检测'
</script>

<template>
  <div class="admin-page relay-page">
    <header class="admin-page__header"><div><span class="admin-kicker">PRIVATE GATEWAYS</span><h1>我的中转</h1><p>连接自己的模型服务。凭据只保存在 Hub 服务端，其他用户无法查看或调度。</p></div><button class="button button--primary" @click="create"><IconPlus :size="17" />添加中转</button></header>
    <section class="relay-ledger">
      <article v-for="item in data?.relays || []" :key="item.id" class="relay-row">
        <div class="relay-identity"><span><IconServerBolt :size="19" /></span><div><strong>{{ item.name }}</strong><code>{{ item.baseUrl }}</code><small>仅自己 · {{ item.models.length }} 个模型</small></div></div>
        <div class="relay-protocols"><span v-for="protocol in item.protocols" :key="protocol.id || protocol.protocol" :data-status="protocol.verificationStatus"><i />{{ protocolLabel(protocol.protocol) }}</span></div>
        <div class="relay-health"><strong>{{ item.healthStatus === 'healthy' ? '可用' : item.healthStatus === 'unhealthy' ? '需处理' : '待检测' }}</strong><small>{{ date(item.lastHealthCheckAt) }}</small><em v-if="item.lastHealthError">{{ item.lastHealthError }}</em></div>
        <div class="table-actions"><button class="icon-button" title="协议检测" :disabled="testing === item.id" @click="testingCandidate = item"><IconRefresh :class="{ 'is-spinning': testing === item.id }" :size="17" /></button><button class="icon-button" title="同步模型" :disabled="syncing === item.id" @click="sync(item)"><IconCloudDownload :size="17" /></button><button class="icon-button" title="生成客户端配置" @click="openConfig(item)"><IconCode :size="17" /></button><button class="icon-button" title="编辑" @click="edit(item)"><IconEdit :size="17" /></button><button class="icon-button danger" title="删除" @click="deleting = item"><IconTrash :size="17" /></button></div>
      </article>
      <div v-if="!data?.relays.length" class="admin-empty relay-empty"><IconServerBolt :size="26" /><strong>还没有私有中转</strong><p>添加一个支持 Messages、Responses 或 Chat 的站点。</p><button class="button button--primary button--small" @click="create">添加第一个中转</button></div>
    </section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true"><header><div><span>PRIVATE RELAY</span><h2>{{ editing ? '编辑中转' : '添加中转' }}</h2></div><button class="icon-button" title="关闭" @click="showForm = false"><IconX :size="18" /></button></header><form class="admin-form" @submit.prevent="save">
      <div class="form-grid"><label><span>名称 *</span><input v-model="form.name" required placeholder="例如：我的多协议站"></label><label><span>Base URL *</span><input v-model="form.baseUrl" type="url" required placeholder="https://relay.example.com"></label></div>
      <label><span>上游 API Key {{ editing ? '（留空保持不变）' : '*' }}</span><input v-model="form.apiKey" type="password" :required="!editing" autocomplete="off"></label>
      <section class="form-section"><header><div><h3>上游协议</h3><span>可以多选</span></div></header><div class="protocol-picker"><button v-for="option in protocolOptions" :key="option.id" type="button" :class="{ active: form.protocols.includes(option.id) }" @click="toggleProtocol(option.id)"><IconCheck :size="15" /><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button></div></section>
      <section class="form-section"><header><div><h3>模型映射</h3><span>可留空后从上游同步</span></div><button type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" />添加模型</button></header><div class="relay-model-list"><div v-for="(model, index) in form.models" :key="model.id || index" class="relay-model-row"><input v-model="model.publicModel" placeholder="Hub 模型名（留空自动同名）"><span>→</span><input v-model="model.upstreamModel" placeholder="上游模型名"><button type="button" class="icon-button danger" title="移除模型" aria-label="移除模型" @click="removeModel(index)"><IconX :size="15" /></button></div></div></section>
      <div class="form-grid form-grid--four"><label><span>优先级</span><input v-model.number="form.priority" type="number" min="0"></label><label><span>权重</span><input v-model.number="form.weight" type="number" min="1"></label><label><span>最大并发</span><input v-model.number="form.maxConcurrency" type="number" min="1"></label><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="1000"></label></div>
      <p v-if="error" class="form-error">{{ error }}</p><footer><label class="switch"><input v-model="form.enabled" type="checkbox"><span />启用中转</label><div><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '保存中' : '保存中转' }}</button></div></footer>
    </form></section></div>

    <div v-if="configuring" class="admin-modal-backdrop" @click.self="configuring = null"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true"><header><div><span>CLIENT SETUP</span><h2>连接 {{ configuring.name }}</h2></div><button class="icon-button" title="关闭" @click="configuring = null"><IconX :size="18" /></button></header><div class="config-builder">
      <div class="config-tabs"><button :class="{ active: configMode === 'claude' }" :disabled="!configuring.protocols.some(item => item.protocol === 'anthropic_messages' || item.protocol === 'openai_chat')" @click="configMode = 'claude'">Claude Code</button><button :class="{ active: configMode === 'codex' }" :disabled="!configuring.protocols.some(item => item.protocol === 'openai_responses')" @click="configMode = 'codex'">Codex</button></div>
      <label><span>模型</span><AppSelect v-model="configModel"><option v-for="model in configuring.models" :key="model.id || model.publicModel" :value="model.publicModel">{{ model.publicModel }}</option></AppSelect></label>
      <div class="key-choice"><label><span>Hub Key</span><AppSelect v-model="selectedKeyId"><option value="new">新建专用 Key</option><option v-for="key in keyData?.keys.filter(item => item.status === 'active') || []" :key="key.id" :value="key.id">{{ key.name }} · {{ key.maskedKey }}</option></AppSelect></label><label v-if="selectedKeyId !== 'new'"><span>当前密码</span><input v-model="keyPassword" type="password" autocomplete="current-password" placeholder="读取完整 Key 前验证"></label></div>
      <div class="key-provision"><div><IconKey :size="18" /><span><strong>专用 Hub Key</strong><small>固定到该私有中转，不会回退平台渠道。</small></span></div><button class="button button--secondary button--small" :disabled="busy || !configModel" @click="useExistingKey">{{ generatedKey ? '重新绑定' : selectedKeyId === 'new' ? '生成专用 Key' : '绑定并读取 Key' }}</button></div>
      <pre><code>{{ configText }}</code></pre><button class="button button--primary" :disabled="!configText" @click="copyConfig"><IconCopy :size="16" />复制配置</button><p v-if="error" class="form-error">{{ error }}</p>
    </div></section></div>
    <AppConfirmDialog :open="Boolean(testingCandidate)" title="执行协议检测" :message="`将对“${testingCandidate?.name || ''}”的每个协议发送一次最小推理请求，上游可能计费。是否继续？`" :busy="Boolean(testing)" @close="testingCandidate = null" @confirm="confirmTest" />
    <AppConfirmDialog :open="Boolean(deleting)" title="删除中转" :message="`删除“${deleting?.name || ''}”后，绑定它的专用 Key 将不再有可用渠道。`" :busy="busy" @close="deleting = null" @confirm="remove" />
  </div>
</template>

<style scoped>
.relay-ledger { display:grid; gap:.65rem; }
.relay-row { min-height:96px; display:grid; grid-template-columns:minmax(230px,1.25fr) minmax(190px,.85fr) minmax(130px,.55fr) auto; gap:1rem; align-items:center; padding:1rem; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface); }
.relay-identity { min-width:0; display:flex; align-items:center; gap:.75rem; }
.relay-identity > span { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--line-strong); color:var(--accent); background:var(--surface-soft); }
.relay-identity > div,.relay-health { min-width:0; display:grid; gap:.2rem; }
.relay-identity code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); font-size:.72rem; }
.relay-identity small,.relay-health small { color:var(--text-muted); font-size:.72rem; }
.relay-protocols { display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-protocols span { display:inline-flex; align-items:center; gap:.35rem; min-height:28px; padding:0 .55rem; border:1px solid var(--line-subtle); border-radius:4px; font-size:.7rem; }
.relay-protocols i { width:6px; height:6px; border-radius:50%; background:var(--text-muted); }
.relay-protocols span[data-status="verified"] i { background:#1a8b62; }
.relay-protocols span[data-status="failed"] i { background:#c5483d; }
.relay-health em { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#b42318; font-size:.68rem; font-style:normal; }
.relay-empty { min-height:260px; display:grid; place-items:center; align-content:center; gap:.55rem; text-align:center; }
.relay-empty p { margin:0; color:var(--text-muted); }
.protocol-picker { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.55rem; }
.protocol-picker button { min-height:64px; display:flex; align-items:center; gap:.55rem; padding:.65rem; text-align:left; color:var(--text); border:1px solid var(--line-strong); background:var(--surface-soft); }
.protocol-picker button > svg { flex:none; opacity:0; }
.protocol-picker button.active { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 8%,var(--surface)); }
.protocol-picker button.active > svg { opacity:1; color:var(--accent); }
.protocol-picker button span { display:grid; gap:.15rem; }
.protocol-picker small { color:var(--text-muted); font-size:.68rem; }
.relay-model-list { display:grid; gap:.5rem; }
.relay-model-row { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto; gap:.5rem; align-items:center; }
.relay-model-row > span { color:var(--text-muted); }
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
@media (max-width:900px) { .relay-row { grid-template-columns:1fr auto; } .relay-protocols,.relay-health { grid-column:1 / -1; } }
@media (max-width:640px) { .protocol-picker,.key-choice { grid-template-columns:1fr; } .relay-row { grid-template-columns:1fr; } .relay-row > .table-actions { justify-content:flex-end; } .relay-model-row { grid-template-columns:1fr auto; } .relay-model-row > span { display:none; } .key-provision { align-items:flex-start; flex-direction:column; } }
</style>
