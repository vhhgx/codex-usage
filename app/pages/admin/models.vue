<script setup lang="ts">
import { IconCloudDownload, IconCoin, IconDeviceFloppy, IconPlus, IconRoute, IconX } from '@tabler/icons-vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '模型与价格 | Zephyr Hub' })

interface ImagePrice { key: string; value: number }
interface ModelDraft { strategy: 'priority' | 'weighted_round_robin'; enabled: boolean; inputPerMillion: number; outputPerMillion: number; cachedPerMillion: number; reasoningPerMillion: number; effectiveAt: string; imagePrices: ImagePrice[] }
interface ModelConfig { id: string; publicModel: string; strategy: 'priority' | 'weighted_round_robin'; enabled: boolean; endpoints: string[]; imageCapable: boolean; price: null | { inputPerMillion: string; outputPerMillion: string; cachedPerMillion: string; reasoningPerMillion: string; imagePrices: Record<string, number>; effectiveAt: string } }
interface PriceSyncResult { total: number; updated: number; unavailable: string[]; failed: Array<{ model: string; message: string }>; imageTokenPricingNotImported: string[] }
const { data, refresh } = await useFetch<{ models: ModelConfig[] }>('/api/admin/models')
const drafts = reactive<Record<string, ModelDraft>>({})
const saving = ref(new Set<string>())
const syncingPrices = ref(false)
const toast = useAppToast()
const defaultImagePrices = ['1024x1024:auto', '1024x1024:high', '1536x1024:high', '1024x1536:high']
const isImageCapable = (item: ModelConfig) => item.imageCapable

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
    <section class="model-config-list">
      <article v-for="item in data?.models || []" :key="item.publicModel" class="model-config-row" :data-image-capable="isImageCapable(item)">
        <header><div class="model-mark"><IconRoute :size="19" /></div><div><code>{{ item.publicModel }}</code><span>{{ draft(item).enabled ? '对外可用' : '已隐藏' }}</span></div><label class="switch"><input v-model="draft(item).enabled" type="checkbox"><span /></label></header>
        <label><span>调度策略</span><AppSelect v-model="draft(item).strategy"><option value="priority">优先级 + 故障转移</option><option value="weighted_round_robin">加权轮询 + 故障转移</option></AppSelect></label>
        <div class="model-prices"><label><span>输入 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).inputPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>输出 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).outputPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>缓存 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).cachedPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>推理 / 1M</span><div><IconCoin :size="14" /><input v-model="draft(item).reasoningPerMillion" type="number" min="0" step="0.000001"></div></label><label><span>生效时间</span><input v-model="draft(item).effectiveAt" type="datetime-local" step="1"></label></div>
        <section v-if="isImageCapable(item)" class="image-price-editor"><header><div><span>IMAGE PRICES</span><h3>图片规格价格</h3></div><button class="button button--quiet button--small" @click="addImagePrice(item)"><IconPlus :size="15" />添加规格</button></header><div><label v-for="(row, index) in draft(item).imagePrices" :key="index"><input v-model="row.key" placeholder="1024x1024:high"><span><IconCoin :size="14" /><input v-model.number="row.value" type="number" min="0" step="0.000001"></span><button class="icon-button danger" title="移除规格" @click="draft(item).imagePrices.splice(index, 1)"><IconX :size="15" /></button></label></div></section>
        <button class="button button--secondary button--small" :disabled="saving.has(item.publicModel)" @click="save(item)"><IconDeviceFloppy :size="16" />{{ saving.has(item.publicModel) ? '保存中' : '保存' }}</button>
      </article>
      <div v-if="!data?.models.length" class="admin-empty admin-empty--large">添加渠道模型映射后，模型池会自动出现在这里。</div>
    </section>
  </div>
</template>
