<script setup lang="ts">
import { IconActivityHeartbeat, IconChevronDown, IconCloudDownload, IconPlus, IconRefresh, IconRoute, IconSearch, IconTrash, IconX } from '@tabler/icons-vue'
import type { ChannelModelView, ChannelType, ChannelView } from '#shared/types/hub'

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
const { show: showToast } = useAppToast()
const showForm = ref(false)
const editing = ref<ChannelView | null>(null)
const saving = ref(false)
const syncingModels = ref(false)
const modelSyncResult = ref('')
const showAvailableModels = ref(false)
const modelSearch = ref('')
const testing = ref(new Set<string>())
const error = ref('')
const groupPanel = ref<{ openCreate: () => void } | null>(null)
const planPanel = ref<{ openCreate: () => void } | null>(null)
const deletingChannel = ref<ChannelView | null>(null)
const endpointOptions = ['/v1/chat/completions','/v1/responses','/v1/embeddings','/v1/images/generations','/v1/images/edits']
const form = reactive({ name: '', type: 'cpa' as ChannelType, baseUrl: '', apiKey: '', enabled: true, priority: 100, weight: 1, maxConcurrency: 20, timeoutMs: 120000, priceMultiplier: 1, models: [] as ChannelModelView[] })
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

function reset() { Object.assign(form, { name: '', type: 'cpa', baseUrl: '', apiKey: '', enabled: true, priority: 100, weight: 1, maxConcurrency: 20, timeoutMs: settingsData.value?.settings.defaultTimeoutMs || 120000, priceMultiplier: 1, models: [{ publicModel: '', upstreamModel: '', enabled: true, endpoints: [] }] }) }
function create() { editing.value = null; reset(); error.value = ''; modelSyncResult.value = ''; modelSearch.value = ''; showAvailableModels.value = false; showForm.value = true }
function edit(item: ChannelView) { editing.value = item; Object.assign(form, { ...item, apiKey: '', models: item.models.map(model => ({ ...model, endpoints: [...model.endpoints] })) }); error.value = ''; modelSyncResult.value = ''; modelSearch.value = ''; showAvailableModels.value = false; showForm.value = true }
function addModel() { form.models.push({ publicModel: '', upstreamModel: '', enabled: true, endpoints: [] }) }
function removeModel(model: ChannelModelView) { const index = form.models.indexOf(model); if (index >= 0) form.models.splice(index, 1) }
async function save() {
  saving.value = true; error.value = ''
  try {
    if (editing.value) await $fetch(`/api/admin/channels/${editing.value.id}`, { method: 'PATCH', body: form })
    else await $fetch('/api/admin/channels', { method: 'POST', body: form })
    showForm.value = false; await refresh()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '保存失败' }
  finally { saving.value = false }
}
async function test(item: ChannelView) {
  testing.value = new Set(testing.value).add(item.id)
  try { await $fetch(`/api/admin/channels/${item.id}/test`, { method: 'POST' }); await refresh() }
  finally { const next = new Set(testing.value); next.delete(item.id); testing.value = next }
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
        <div class="channel-row__identity"><span class="channel-logo" :data-type="item.type"><IconRoute :size="20" /></span><div><strong>{{ item.name }}</strong><code>{{ item.baseUrl }}</code><small>{{ item.type.toUpperCase() }} · 优先级 {{ item.priority }}</small></div></div>
        <div class="channel-row__health"><span class="status-dot" :data-status="!item.enabled ? 'disabled' : item.circuitState === 'open' ? 'unhealthy' : item.circuitState === 'half_open' ? 'unknown' : item.healthStatus"><i />{{ !item.enabled ? '已停用' : item.circuitState === 'open' ? '已熔断' : item.circuitState === 'half_open' ? '等待探测' : item.healthStatus === 'healthy' ? '健康' : item.healthStatus === 'unhealthy' ? '异常' : '待检测' }}</span><small>{{ time(item.lastHealthCheckAt) }}</small><em v-if="item.lastHealthError">{{ item.lastHealthError }}</em></div>
        <div class="channel-row__models"><span>模型映射</span><strong>{{ item.models.filter(model => model.enabled).length }}</strong><small>{{ item.models.slice(0, 3).map(model => model.publicModel).join(' · ') || '尚未配置' }}</small></div>
        <div class="channel-row__policy"><span>调度参数</span><strong>{{ item.weight }}× 权重</strong><small>{{ item.maxConcurrency }} 并发 · {{ item.timeoutMs / 1000 }}s</small></div>
        <div class="table-actions"><button class="icon-button" type="button" title="健康检测" aria-label="健康检测" :disabled="testing.has(item.id)" @click="test(item)"><IconRefresh :class="{ 'is-spinning': testing.has(item.id) }" :size="17" /></button><button class="icon-button" type="button" :title="item.enabled ? '停用' : '启用'" :aria-label="item.enabled ? '停用渠道' : '启用渠道'" @click="toggle(item)"><IconActivityHeartbeat :size="17" /></button><button class="button button--quiet button--small" type="button" @click="edit(item)">配置</button><button class="icon-button danger" type="button" title="删除渠道" aria-label="删除渠道" @click="deletingChannel = item"><IconTrash :size="16" /></button></div>
      </article>
      <div v-if="!data?.channels.length" class="admin-empty admin-empty--large">还没有渠道。添加 CPA 或 Sub2API 后才能开始转发。</div>
    </section>

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="showForm = false"><section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true">
      <header><div><span>UPSTREAM CHANNEL</span><h2 class="text-balance">{{ editing ? '编辑渠道' : '连接新渠道' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showForm = false"><IconX :size="18" /></button></header>
      <form class="admin-form" @submit.prevent="save">
        <div class="form-grid"><label><span>渠道名称 *</span><input v-model="form.name" required placeholder="例如：CPA 主节点"></label><label><span>渠道类型 *</span><AppSelect v-model="form.type" :disabled="Boolean(editing)"><option value="cpa">CPA / CLIProxyAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
        <label><span>Base URL *</span><input v-model="form.baseUrl" type="url" required placeholder="https://upstream.example.com"></label>
        <label><span>上游 API Key {{ editing ? '（留空保持不变）' : '*' }}</span><input v-model="form.apiKey" type="password" :required="!editing" autocomplete="off"></label>
        <div class="form-grid form-grid--four"><label><span>优先级</span><input v-model.number="form.priority" type="number" min="0"></label><label><span>权重</span><input v-model.number="form.weight" type="number" min="1"></label><label><span>最大并发</span><input v-model.number="form.maxConcurrency" type="number" min="1"></label><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="1000"></label></div>
        <section v-if="form.type === 'sub2api'" class="form-section auto-model-sync"><header><div><h3>自动模型发现</h3><span>{{ editing ? `${form.models.filter(model => model.publicModel && model.upstreamModel).length} 个已同步模型` : '保存时从上游读取' }}</span></div><div v-if="editing" class="auto-model-actions"><button type="button" class="button button--quiet button--small" @click="showAvailableModels = !showAvailableModels"><IconChevronDown :class="{ 'is-rotated': showAvailableModels }" :size="15" />{{ showAvailableModels ? '收起模型' : '查看模型' }}</button><button type="button" class="button button--quiet button--small" :disabled="syncingModels" @click="syncModels"><IconCloudDownload :size="15" />{{ syncingModels ? '同步中' : '同步上游模型' }}</button></div></header><p>系统读取上游 <code>/v1/models</code>，自动建立同名映射；后续健康检查会持续补充新模型，且不会覆盖手工映射。</p><small v-if="modelSyncResult">{{ modelSyncResult }}</small><div v-if="showAvailableModels" class="available-models"><label><IconSearch :size="15" /><input v-model="modelSearch" type="search" placeholder="搜索模型"></label><div class="available-models__list"><div v-for="model in availableModels" :key="model.id || `${model.publicModel}:${model.upstreamModel}`"><code>{{ model.publicModel }}</code><span v-if="model.publicModel !== model.upstreamModel">→ <code>{{ model.upstreamModel }}</code></span><em :data-source="manualModels.includes(model) ? 'manual' : 'automatic'">{{ manualModels.includes(model) ? '手工' : '自动' }}</em></div><p v-if="!availableModels.length">没有匹配的模型</p></div></div></section>
        <section v-if="form.type === 'sub2api'" class="form-section"><header><div><h3>手动模型映射</h3><span>可选 · 同名冲突时手工配置优先</span></div><button type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" /> 添加映射</button></header>
          <div v-if="manualModels.length" class="model-mapping-list"><div v-for="(model, index) in manualModels" :key="model.id || index" class="model-mapping"><input v-model="model.publicModel" required placeholder="Hub 模型名"><span>→</span><input v-model="model.upstreamModel" required placeholder="上游模型名"><AppSelect v-model="model.endpoints" multiple title="限制支持端点（留空表示全部）"><option v-for="endpoint in endpointOptions" :key="endpoint" :value="endpoint">{{ endpoint.replace('/v1/', '') }}</option></AppSelect><button type="button" class="icon-button danger" title="移除" @click="removeModel(model)"><IconX :size="15" /></button></div></div><p v-else class="form-section-empty">当前没有手工映射，全部使用上游自动发现结果。</p>
        </section>
        <section v-else class="form-section"><header><h3>模型映射</h3><button type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" /> 添加模型</button></header>
          <div class="model-mapping-list"><div v-for="(model, index) in form.models" :key="index" class="model-mapping"><input v-model="model.publicModel" required placeholder="Hub 模型名"><span>→</span><input v-model="model.upstreamModel" required placeholder="上游模型名"><AppSelect v-model="model.endpoints" multiple title="支持端点"><option v-for="endpoint in endpointOptions" :key="endpoint" :value="endpoint">{{ endpoint.replace('/v1/', '') }}</option></AppSelect><button type="button" class="icon-button danger" title="移除" @click="removeModel(model)"><IconX :size="15" /></button></div></div>
        </section>
        <p v-if="error" class="form-error">{{ error }}</p><footer><label class="switch"><input v-model="form.enabled" type="checkbox"><span />启用渠道</label><div><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button type="submit" class="button button--primary" :disabled="saving">{{ saving ? '正在保存' : '保存渠道' }}</button></div></footer>
      </form>
    </section></div>
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
