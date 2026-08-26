<script setup lang="ts">
import { IconCloudDownload, IconCoin, IconDeviceFloppy, IconEdit, IconPlus, IconRoute, IconTrash, IconX } from '@tabler/icons-vue'
import type { ChannelProtocol, ProbeModelCatalogView } from '#shared/types/hub'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '模型与价格 | Zephyr Hub' })

interface ImagePrice { key: string; value: number }
interface ModelDraft { strategy: 'priority' | 'weighted_round_robin'; enabled: boolean; inputPerMillion: number; outputPerMillion: number; cachedPerMillion: number; reasoningPerMillion: number; effectiveAt: string; imagePrices: ImagePrice[] }
interface ModelConfig { id: string; publicModel: string; strategy: 'priority' | 'weighted_round_robin'; enabled: boolean; endpoints: string[]; imageCapable: boolean; price: null | { inputPerMillion: string; outputPerMillion: string; cachedPerMillion: string; reasoningPerMillion: string; imagePrices: Record<string, number>; effectiveAt: string } }
interface PriceSyncResult { total: number; updated: number; unavailable: string[]; failed: Array<{ model: string; message: string }>; imageTokenPricingNotImported: string[] }
const { data, refresh } = await useFetch<{ models: ModelConfig[] }>('/api/admin/models')
const { data: probeData, refresh: refreshProbeModels } = await useFetch<{ models: ProbeModelCatalogView[] }>('/api/admin/probe-models')
const drafts = reactive<Record<string, ModelDraft>>({})
const saving = ref(new Set<string>())
const syncingPrices = ref(false)
const toast = useAppToast()
const defaultImagePrices = ['1024x1024:auto', '1024x1024:high', '1536x1024:high', '1024x1536:high']
const isImageCapable = (item: ModelConfig) => item.imageCapable
const showProbeForm = ref(false)
const editingProbe = ref<ProbeModelCatalogView | null>(null)
const deletingProbe = ref<ProbeModelCatalogView | null>(null)
const probeSaving = ref(false)
const probeError = ref('')
const probeForm = reactive({ vendor: '', protocol: 'anthropic_messages' as ChannelProtocol, model: '', displayName: '', enabled: true, sortOrder: 100 })
const probeProtocolLabels: Record<ChannelProtocol, string> = { anthropic_messages: 'Messages', openai_responses: 'Responses', openai_chat: 'Chat Completions' }
const probeEndpoint: Record<ChannelProtocol, string> = { anthropic_messages: '/v1/messages', openai_responses: '/v1/responses', openai_chat: '/v1/chat/completions' }

function openProbeForm(item?: ProbeModelCatalogView) {
  editingProbe.value = item || null
  Object.assign(probeForm, item ? { vendor: item.vendor, protocol: item.protocol, model: item.model, displayName: item.displayName, enabled: item.enabled, sortOrder: item.sortOrder } : { vendor: '', protocol: 'anthropic_messages', model: '', displayName: '', enabled: true, sortOrder: 100 })
  probeError.value = ''
  showProbeForm.value = true
}
async function saveProbeModel() {
  probeSaving.value = true; probeError.value = ''
  try {
    if (editingProbe.value) await $fetch(`/api/admin/probe-models/${editingProbe.value.id}`, { method: 'PATCH', body: probeForm })
    else await $fetch('/api/admin/probe-models', { method: 'POST', body: probeForm })
    showProbeForm.value = false
    await refreshProbeModels()
    toast.show(editingProbe.value ? '探测模型已更新' : '探测模型已添加', 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    probeError.value = failure.data?.message || failure.message || '保存探测模型失败'
  } finally { probeSaving.value = false }
}
async function removeProbeModel() {
  if (!deletingProbe.value) return
  probeSaving.value = true
  try {
    await $fetch(`/api/admin/probe-models/${deletingProbe.value.id}`, { method: 'DELETE' })
    deletingProbe.value = null
    await refreshProbeModels()
    toast.show('探测模型已删除', 'success')
  } finally { probeSaving.value = false }
}

function localDate(value?: string) {
  const scheduled = value ? new Date(value) : null
  const date = scheduled && scheduled.getTime() > Date.now() ? scheduled : new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 19)
}

function draft(item: ModelConfig) {
  if (!drafts[item.publicModel]) drafts[item.publicModel] = {
    strategy: item.strategy, enabled: item.enabled,
    inputPerMillion: Number(item.price?.inputPerMillion || 0), outputPerMillion: Number(item.price?.outputPerMillion || 0),
    cachedPerMillion: Number(item.price?.cachedPerMillion || 0), reasoningPerMillion: Number(item.price?.reasoningPerMillion || 0),
    effectiveAt: localDate(item.price?.effectiveAt),
    imagePrices: isImageCapable(item) && Object.entries(item.price?.imagePrices || {}).length
      ? Object.entries(item.price?.imagePrices || {}).map(([key, value]) => ({ key, value: Number(value) }))
      : isImageCapable(item) ? defaultImagePrices.map(key => ({ key, value: 0 })) : []
  }
  return drafts[item.publicModel]!
}
async function save(item: ModelConfig) {
  saving.value = new Set(saving.value).add(item.publicModel)
  const value = draft(item)
  try {
    await $fetch(`/api/admin/models/${encodeURIComponent(item.publicModel)}`, { method: 'PUT', body: {
      strategy: value.strategy, enabled: value.enabled,
      price: { inputPerMillion: value.inputPerMillion, outputPerMillion: value.outputPerMillion, cachedPerMillion: value.cachedPerMillion, reasoningPerMillion: value.reasoningPerMillion, effectiveAt: new Date(value.effectiveAt).toISOString(), imagePrices: isImageCapable(item) ? Object.fromEntries(value.imagePrices.filter(row => row.key.trim()).map(row => [row.key.trim(), Number(row.value) || 0])) : {} }
    } })
    await refresh()
  } finally { const next = new Set(saving.value); next.delete(item.publicModel); saving.value = next }
}
function addImagePrice(item: ModelConfig) { draft(item).imagePrices.push({ key: '', value: 0 }) }
async function syncPrices() {
  syncingPrices.value = true
  try {
    const result = await $fetch<PriceSyncResult>('/api/admin/models/sync-prices', { method: 'POST' })
    Object.keys(drafts).forEach(key => delete drafts[key])
    await refresh()
    const skipped = result.unavailable.length + result.failed.length
    const imageNote = result.imageTokenPricingNotImported.length ? `；${result.imageTokenPricingNotImported.length} 个图片模型保留规格价格` : ''
    toast.show(`已从上游更新 ${result.updated} / ${result.total} 个模型${skipped ? `，跳过 ${skipped} 个` : ''}${imageNote}`, result.updated ? 'success' : 'info')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '同步上游价格失败', 'error')
  } finally {
    syncingPrices.value = false
  }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">MODEL CATALOG</span><h1>模型与价格</h1><p>选择模型池调度策略，并定义 Hub 额度结算价格。</p></div><button class="button button--secondary" :disabled="syncingPrices" title="从 Sub2API 定价目录同步" @click="syncPrices"><IconCloudDownload :size="17" />{{ syncingPrices ? '同步中' : '从上游同步价格' }}</button></header>
    <section class="probe-catalog">
      <header><div><span class="admin-kicker">PROBE MODELS</span><h2>协议探测模型</h2><p>按端点维护健康检测使用的模型；渠道仍可手工输入上游自定义模型。</p></div><button class="button button--primary button--small" @click="openProbeForm()"><IconPlus :size="16" />添加模型</button></header>
      <div class="probe-model-list"><article v-for="item in probeData?.models || []" :key="item.id" :data-disabled="!item.enabled"><div><strong>{{ item.displayName }}</strong><code>{{ item.model }}</code></div><div><span>{{ item.vendor }}</span><small>{{ probeProtocolLabels[item.protocol] }} · {{ item.endpoint }} · 顺序 {{ item.sortOrder }}</small></div><div class="table-actions"><button class="icon-button" title="编辑探测模型" aria-label="编辑探测模型" @click="openProbeForm(item)"><IconEdit :size="16" /></button><button class="icon-button danger" title="删除探测模型" aria-label="删除探测模型" @click="deletingProbe = item"><IconTrash :size="16" /></button></div></article><div v-if="!probeData?.models.length" class="admin-empty">还没有探测模型</div></div>
    </section>
    <section class="model-config-list">
      <article v-for="item in data?.models || []" :key="item.publicModel" class="model-config-row" :data-image-capable="isImageCapable(item)">
        <header><div class="model-mark"><IconRoute :size="19" /></div><div><code>{{ item.publicModel }}</code><span>{{ draft(item).enabled ? '对外可用' : '已隐藏' }}</span></div><label class="switch"><input v-model="draft(item).enabled" type="checkbox"><span /></label></header>
        <label><span>调度策略</span><AppSelect v-model="draft(item).strategy"><option value="priority">优先级 + 故障转移</option><option value="weighted_round_robin">加权轮询 + 故障转移</option></AppSelect></label>
        <div class="model-prices"><label><span>输入 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).inputPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>输出 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).outputPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>缓存 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).cachedPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>推理 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).reasoningPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>生效时间</span><input v-model="draft(item).effectiveAt" type="datetime-local" step="1"></label></div>
        <section v-if="isImageCapable(item)" class="image-price-editor"><header><div><span>IMAGE PRICES</span><h3>图片规格价格</h3></div><button class="button button--quiet button--small" @click="addImagePrice(item)"><IconPlus :size="15" />添加规格</button></header><div><label v-for="(row, index) in draft(item).imagePrices" :key="index"><input v-model="row.key" placeholder="1024x1024:high"><span><IconCoin :size="14" /><input v-model.number="row.value" type="number" min="0" step="0.000001"></span><button class="icon-button danger" title="移除规格" aria-label="移除图片规格" @click="draft(item).imagePrices.splice(index, 1)"><IconX :size="15" /></button></label></div></section>
        <button class="button button--secondary button--small" :disabled="saving.has(item.publicModel)" @click="save(item)"><IconDeviceFloppy :size="16" />{{ saving.has(item.publicModel) ? '保存中' : '保存' }}</button>
      </article>
      <div v-if="!data?.models.length" class="admin-empty admin-empty--large">添加渠道模型映射后，模型池会自动出现在这里。</div>
    </section>
    <AppDrawer :open="showProbeForm" kicker="PROBE MODEL" :title="editingProbe ? '编辑探测模型' : '添加探测模型'" @close="showProbeForm = false"><form class="admin-form" @submit.prevent="saveProbeModel"><div class="form-grid"><label><span>厂商 *</span><input v-model="probeForm.vendor" required placeholder="Anthropic"></label><label><span>协议 / 端点 *</span><AppSelect v-model="probeForm.protocol"><option value="anthropic_messages">Messages · /v1/messages</option><option value="openai_responses">Responses · /v1/responses</option><option value="openai_chat">Chat · /v1/chat/completions</option></AppSelect></label></div><label><span>模型 ID *</span><input v-model="probeForm.model" required placeholder="claude-sonnet-5"></label><label><span>显示名称 *</span><input v-model="probeForm.displayName" required placeholder="Claude Sonnet 5"></label><div class="form-grid"><label><span>排序</span><input v-model.number="probeForm.sortOrder" type="number" min="0" max="10000"></label><label class="switch"><input v-model="probeForm.enabled" type="checkbox"><span />在渠道配置中可选</label></div><InlineNotice v-if="probeError" tone="error" title="保存失败" :message="probeError" /><footer><button type="button" class="button button--quiet" @click="showProbeForm = false">取消</button><button type="submit" class="button button--primary" :disabled="probeSaving"><IconDeviceFloppy :size="16" />{{ probeSaving ? '保存中' : '保存' }}</button></footer></form></AppDrawer>
    <AppConfirmDialog :open="Boolean(deletingProbe)" title="删除探测模型" :message="`删除“${deletingProbe?.displayName || ''}”？已有渠道中保存的检测模型不会被修改。`" :busy="probeSaving" @close="deletingProbe = null" @confirm="removeProbeModel" />
  </div>
</template>

<style scoped>
.probe-catalog { margin-bottom:1.25rem; border-top:1px solid var(--hub-line); border-bottom:1px solid var(--hub-line); }
.probe-catalog > header { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; padding:1rem 0; }
.probe-catalog h2,.probe-catalog p { margin:.2rem 0 0; }
.probe-catalog p { color:var(--hub-text-muted); font-size:.76rem; }
.probe-model-list { display:grid; }
.probe-model-list article { display:grid; grid-template-columns:minmax(180px,1.1fr) minmax(240px,1fr) auto; align-items:center; gap:1rem; padding:.75rem 0; border-top:1px solid var(--hub-line-row); }
.probe-model-list article[data-disabled="true"] { opacity:.55; }
.probe-model-list article > div:not(.table-actions) { min-width:0; display:grid; gap:.2rem; }
.probe-model-list code,.probe-model-list small { overflow:hidden; text-overflow:ellipsis; color:var(--hub-text-faint); font-size:.69rem; }
@media (max-width:700px) { .probe-catalog > header { align-items:flex-start; } .probe-model-list article { grid-template-columns:1fr auto; } .probe-model-list article > div:nth-child(2) { grid-column:1 / -1; grid-row:2; } }
</style>
