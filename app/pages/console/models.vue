<script setup lang="ts">
import { IconBraces, IconRefresh, IconSearch } from '@tabler/icons-vue'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '可用模型 | Zephyr Hub' })
interface Pricing { inputPerMillion: number; outputPerMillion: number; cachedPerMillion: number; reasoningPerMillion: number; imagePrices: Record<string, number> }
interface Model { id: string; endpoints: string[]; pricing: Pricing | null }
const { data, refresh, pending } = await useFetch<{ models: Model[] }>('/api/console/models')
const search = ref('')
const endpoint = ref('')
const endpointOptions = computed(() => [...new Set((data.value?.models || []).flatMap(model => model.endpoints))].sort())
const filtered = computed(() => (data.value?.models || []).filter(model => (!search.value.trim() || model.id.toLowerCase().includes(search.value.trim().toLowerCase())) && (!endpoint.value || model.endpoints.includes(endpoint.value))))
const money = (value: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
const endpointLabel = (value: string) => value.replace('/v1/', '')
function reload() { void refresh() }
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">MODEL ACCESS</span><h1>可用模型</h1><p>模型由默认分组和当前健康渠道共同决定，不需要先创建 Key 才能查看。</p></div><button class="button button--secondary" :disabled="pending" @click="reload"><IconRefresh :size="16" />刷新</button></header>
    <section class="admin-toolbar model-toolbar"><label class="admin-search"><IconSearch :size="17" /><input v-model="search" placeholder="搜索模型名称"></label><AppSelect v-model="endpoint"><option value="">全部端点</option><option v-for="item in endpointOptions" :key="item" :value="item">{{ endpointLabel(item) }}</option></AppSelect><span>{{ filtered.length }} / {{ data?.models.length || 0 }} 个模型</span></section>
    <section class="admin-table-wrap console-table"><table class="admin-table model-access-table"><thead><tr><th>模型</th><th>状态</th><th>支持端点</th><th>输入 / 输出</th><th>缓存 / 推理</th></tr></thead><tbody><tr v-for="model in filtered" :key="model.id"><td><div class="table-primary"><span class="key-glyph"><IconBraces :size="16" /></span><div><strong>{{ model.id }}</strong><small>{{ model.endpoints.length }} 个可用端点</small></div></div></td><td><span class="status-label" data-status="active">可用</span></td><td><div class="endpoint-tags endpoint-tags--table"><code v-for="item in model.endpoints" :key="item">{{ endpointLabel(item) }}</code></div></td><td><template v-if="model.pricing"><strong>{{ money(model.pricing.inputPerMillion) }}</strong><small class="table-sub">{{ money(model.pricing.outputPerMillion) }} / M Token</small></template><span v-else>未配置价格</span></td><td><template v-if="model.pricing"><strong>{{ money(model.pricing.cachedPerMillion) }}</strong><small class="table-sub">{{ money(model.pricing.reasoningPerMillion) }} / M Token</small></template><span v-else>—</span></td></tr><tr v-if="!filtered.length"><td colspan="5"><div class="admin-empty console-empty"><div><IconBraces :size="24" /><p>{{ data?.models.length ? '没有匹配的模型' : '当前没有健康渠道支持的模型' }}</p><button v-if="!data?.models.length" class="button button--secondary button--small" @click="reload">重新检查</button></div></div></td></tr></tbody></table></section>
  </div>
</template>
