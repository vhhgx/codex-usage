<script setup lang="ts">
import { IconAddressBook, IconExternalLink, IconRoute, IconServerBolt, IconUserShield } from '@tabler/icons-vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '我的资源 | Zephyr Hub' })

type ResourceTab = 'personal' | 'public'
const route = useRoute()
const router = useRouter()
const activeTab = computed<ResourceTab>(() => route.query.tab === 'public' ? 'public' : 'personal')
function selectTab(tab: ResourceTab) { void router.replace({ query: { ...route.query, tab } }) }
</script>

<template>
  <div class="admin-page admin-resources-page">
    <header class="admin-page__header">
      <div><span class="admin-kicker">ADMIN RESOURCE DESK</span><h1>资源工作台</h1><p>管理员既可维护平台公共资源，也可像普通用户一样维护自己的专属资源。</p></div>
    </header>

    <nav class="admin-page-tabs resource-tabs" role="tablist" aria-label="资源范围">
      <button role="tab" :aria-selected="activeTab === 'personal'" :class="{ active: activeTab === 'personal' }" @click="selectTab('personal')"><IconUserShield :size="17" />我的资源</button>
      <button role="tab" :aria-selected="activeTab === 'public'" :class="{ active: activeTab === 'public' }" @click="selectTab('public')"><IconRoute :size="17" />公共资源</button>
    </nav>

    <template v-if="activeTab === 'personal'">
      <section class="resource-callout"><span class="resource-callout__mark"><IconServerBolt :size="18" /></span><div><strong>管理员个人隔离空间</strong><p>这里的中转、故障转移顺序、签到和专属号池只归当前管理员账号使用，不会混入平台公共渠道。</p></div></section>
      <ConsoleUserRelayOrder />
      <section class="personal-resource-block"><ConsoleUserRelaysPanel /></section>
      <section class="personal-resource-block"><ConsoleUserPoolPanel /></section>
    </template>

    <section v-else class="public-resource-grid" role="tabpanel">
      <article class="public-resource-card"><span><IconRoute :size="18" /></span><div><strong>公共渠道与中转</strong><p>管理平台级渠道、模型映射、健康检测和访问控制。</p><NuxtLink to="/admin/channels" class="button button--secondary button--small">打开资源管理 <IconExternalLink :size="14" /></NuxtLink></div></article>
      <article class="public-resource-card"><span><IconAddressBook :size="18" /></span><div><strong>公共账号资料库</strong><p>批量导入平台账号、凭据转换以及公共接码资源。</p><NuxtLink to="/admin/account-vault" class="button button--secondary button--small">打开账号管理 <IconExternalLink :size="14" /></NuxtLink></div></article>
      <article class="public-resource-card"><span><IconServerBolt :size="18" /></span><div><strong>Sub2API 公共号池</strong><p>维护平台共享的上游账号、代理和容量配置。</p><NuxtLink to="/admin/upstreams" class="button button--secondary button--small">打开号池配置 <IconExternalLink :size="14" /></NuxtLink></div></article>
    </section>
  </div>
</template>

<style scoped>
.resource-tabs { margin-bottom: 1rem; }
.resource-callout { display:flex; align-items:center; gap:.85rem; margin-bottom:1.25rem; padding:.85rem 1rem; border:1px solid var(--hub-line); border-left:3px solid var(--hub-accent); background:var(--hub-solid-surface); }
.resource-callout__mark { width:34px; height:34px; display:grid; place-items:center; color:var(--hub-accent); background:var(--hub-accent-soft); border-radius:6px; flex:none; }
.resource-callout div:nth-child(2) { min-width:0; flex:1; }
.resource-callout strong { font-size:.82rem; }
.resource-callout p { margin:.25rem 0 0; color:var(--hub-text-muted); font-size:.7rem; line-height:1.5; }
.personal-resource-block { margin-top:1.25rem; }
.public-resource-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1rem; }
.public-resource-card { display:flex; gap:.85rem; min-height:160px; padding:1.1rem; border:1px solid var(--hub-line); background:var(--hub-solid-surface); }
.public-resource-card > span { width:34px; height:34px; display:grid; place-items:center; color:var(--hub-accent); background:var(--hub-accent-soft); border-radius:6px; flex:none; }
.public-resource-card strong { font-size:.85rem; }
.public-resource-card p { margin:.45rem 0 1rem; color:var(--hub-text-muted); font-size:.72rem; line-height:1.5; }
@media (max-width:850px) { .public-resource-grid { grid-template-columns:1fr; } .resource-callout { align-items:flex-start; flex-wrap:wrap; } .resource-callout .button { margin-left:42px; } }
</style>
