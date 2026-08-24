<script setup lang="ts">
import { IconRoute, IconServerBolt, IconUserShield } from '@tabler/icons-vue'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '套餐与资源 | Zephyr Hub' })

type ResourceTab = 'relays' | 'pool'
interface PlanView {
  status: string
  startsAt: number
  expiresAt: number | null
  plan: {
    name: string
    mode: 'unlimited' | 'token' | 'cost'
    tokenLimit: number | null
    costLimit: number | null
    entitlementSnapshot?: { billingMode?: string; tokenLimit?: number | null }
  }
  usage: {
    requests: number
    tokens: number
    cost: number
    today: { requests: number; tokens: number; cost: number }
  }
}

const route = useRoute()
const router = useRouter()
const { data: planData } = await useFetch<{ subscription: PlanView | null }>('/api/console/plan')
const activeTab = computed<ResourceTab>(() => route.query.tab === 'pool' ? 'pool' : 'relays')
const plan = computed(() => planData.value?.subscription || null)
const tokenLimit = computed(() => Number(plan.value?.plan.entitlementSnapshot?.tokenLimit ?? plan.value?.plan.tokenLimit) || null)
const remainingTokens = computed(() => tokenLimit.value === null ? null : Math.max(0, tokenLimit.value - Number(plan.value?.usage.tokens || 0)))
const packageType = computed(() => plan.value?.plan.mode === 'unlimited' ? '全包套餐' : plan.value?.plan.mode === 'token' ? '半包套餐' : '按量套餐')
const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value || 0)
const date = (value: number | null | undefined) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(value) : '长期有效'
function selectTab(tab: ResourceTab) { void router.replace({ query: { ...route.query, tab } }) }
</script>

<template>
  <div class="admin-page resources-page">
    <header class="admin-page__header"><div><span class="admin-kicker">PLAN & RESOURCES</span><h1 class="text-balance">套餐与资源</h1><p class="text-pretty">查看套餐权限和额度，管理仅供自己使用的中转与专属号池。</p></div></header>
    <section class="package-summary" :data-status="plan?.status || 'none'">
      <article class="package-summary__identity"><span><IconRoute :size="17" />当前套餐</span><strong>{{ plan?.plan.name || '未分配套餐' }}</strong><small>{{ plan ? `${packageType} · ${date(plan.expiresAt)}` : '请联系管理员配置套餐' }}</small></article>
      <article><span>今日套餐 Token</span><strong class="tabular-nums">{{ compact(plan?.usage.today.tokens || 0) }}</strong><small>{{ compact(plan?.usage.today.requests || 0) }} 次请求</small></article>
      <article><span>本周期套餐 Token</span><strong class="tabular-nums">{{ compact(plan?.usage.tokens || 0) }}</strong><small>自 {{ date(plan?.startsAt) }} 起</small></article>
      <article><span>{{ remainingTokens === null ? '套餐额度' : '剩余 Token' }}</span><strong class="tabular-nums">{{ remainingTokens === null ? '不限量' : compact(remainingTokens) }}</strong><small>{{ tokenLimit === null ? '仅统计套餐供给' : `总额度 ${compact(tokenLimit)}` }}</small></article>
      <footer>套餐用量仅统计平台供给；个人中转和专属号池的消耗不计入。</footer>
    </section>
    <ConsoleUserRelayOrder />
    <nav class="admin-page-tabs resource-tabs" role="tablist" aria-label="套餐与资源">
      <button role="tab" :aria-selected="activeTab === 'relays'" :class="{ active: activeTab === 'relays' }" @click="selectTab('relays')"><IconServerBolt :size="17" />我的中转</button>
      <button role="tab" :aria-selected="activeTab === 'pool'" :class="{ active: activeTab === 'pool' }" @click="selectTab('pool')"><IconUserShield :size="17" />专属号池</button>
    </nav>
    <section class="resource-tab-panel" role="tabpanel">
      <ConsoleUserRelaysPanel v-if="activeTab === 'relays'" />
      <ConsoleUserPoolPanel v-else />
    </section>
  </div>
</template>

<style scoped>
.package-summary { margin-bottom:1rem; display:grid; grid-template-columns:1.2fr repeat(3,1fr); border:1px solid var(--hub-line); border-radius:7px; overflow:hidden; background:var(--hub-solid-surface); }
.package-summary article { min-height:118px; padding:1rem 1.1rem; display:grid; align-content:start; border-right:1px solid var(--hub-line-row); }
.package-summary article:nth-child(4) { border-right:0; }
.package-summary span { display:flex; align-items:center; gap:.4rem; color:var(--hub-text-muted); font-size:.68rem; }
.package-summary strong { margin-top:1rem; font-family:var(--font-mono); font-size:1.45rem; line-height:1.1; overflow-wrap:anywhere; }
.package-summary small { margin-top:.45rem; color:var(--hub-text-faint); font-size:.65rem; }
.package-summary__identity strong { font-family:inherit; font-size:1.15rem; }
.package-summary footer { grid-column:1 / -1; min-height:38px; padding:.65rem 1.1rem; border-top:1px solid var(--hub-line-row); color:var(--hub-text-muted); background:var(--hub-solid-surface-hover); font-size:.7rem; }
.resource-tabs { margin-bottom:0; }
.resource-tab-panel { padding-top:1.25rem; }
@media (max-width:900px) { .package-summary { grid-template-columns:repeat(2,1fr); } .package-summary article:nth-child(2) { border-right:0; } .package-summary article:nth-child(-n+2) { border-bottom:1px solid var(--hub-line-row); } }
@media (max-width:600px) { .package-summary { grid-template-columns:1fr; } .package-summary article { min-height:100px; border-right:0; border-bottom:1px solid var(--hub-line-row); } .package-summary article:nth-child(-n+2) { border-bottom:1px solid var(--hub-line-row); } }
</style>
