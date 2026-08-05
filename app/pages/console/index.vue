<script setup lang="ts">
import { IconAlertTriangle, IconBell, IconBraces, IconCircleCheck, IconCoin, IconKey, IconServer, IconTimeline } from '@tabler/icons-vue'
import type { HubKeyView } from '#shared/types/hub'
import type { AdminSessionView } from '#shared/types/hub'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '个人首页 | Zephyr Hub' })
interface Period { requests: number; tokens: number; cost: number }
interface PlanView { status: string; startsAt: number; expiresAt: number | null; plan: { name: string; description: string | null; mode: 'unlimited' | 'token' | 'cost'; cycle: string; tokenLimit: number | null; costLimit: number | null }; usage: { requests: number; tokens: number; cost: number } }
interface Announcement { id: string; title: string; content: string; tone: 'info' | 'warning' | 'success'; publishedAt: number | null }
interface Overview { periods: Record<'today' | 'week' | 'month', Period>; keys: HubKeyView[]; groups: Array<{ id: string; name: string; status: string }>; models: Array<{ id: string; endpoints: string[] }>; plan: PlanView | null; announcements: Announcement[]; service: { status: string; healthyChannels: number; enabledChannels: number } }
const { data } = await useFetch<Overview>('/api/console/overview')
const session = useState<AdminSessionView | null>('auth-session', () => null)
const announcementDialogOpen = ref(false)
const expiringKeys = computed(() => (data.value?.keys || []).filter(key => key.expiresAt && key.expiresAt > Date.now() && key.expiresAt < Date.now() + 7 * 86400_000))
const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
const money = (value: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(value) : '长期有效'
function shanghaiDay() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}
function announcementStorageKey(scope: 'session' | 'day') {
  return `zephyr:console-announcements:${scope}:${session.value?.user?.id || 'user'}`
}
function closeAnnouncements() {
  announcementDialogOpen.value = false
  sessionStorage.setItem(announcementStorageKey('session'), 'closed')
}
function dismissAnnouncementsToday() {
  localStorage.setItem(announcementStorageKey('day'), shanghaiDay())
  closeAnnouncements()
}
onMounted(() => {
  if (!data.value?.announcements.length) return
  const closedThisSession = sessionStorage.getItem(announcementStorageKey('session')) === 'closed'
  const closedToday = localStorage.getItem(announcementStorageKey('day')) === shanghaiDay()
  announcementDialogOpen.value = !closedThisSession && !closedToday
})
const planUsage = computed(() => {
  const plan = data.value?.plan
  if (!plan || plan.plan.mode === 'unlimited') return null
  const used = plan.plan.mode === 'token' ? plan.usage.tokens : plan.usage.cost
  const limit = plan.plan.mode === 'token' ? Number(plan.plan.tokenLimit || 0) : Number(plan.plan.costLimit || 0)
  return { used, limit, percent: limit ? Math.min(100, used / limit * 100) : 0 }
})
</script>

<template>
  <div class="admin-page console-home">
    <header class="admin-page__header"><div><span class="admin-kicker">MY WORKSPACE</span><h1>个人首页</h1><p>账号套餐、访问凭据和当前服务状态。</p></div><div v-if="data" class="service-health" :data-status="data.service.status"><component :is="data.service.status === 'available' ? IconCircleCheck : IconAlertTriangle" :size="18" /><div><strong>{{ data.service.status === 'available' ? '服务可用' : '服务降级' }}</strong><small>{{ data.service.healthyChannels }} / {{ data.service.enabledChannels }} 个渠道健康</small></div></div></header>
    <template v-if="data">
      <section v-if="data.announcements.length" class="announcement-summary"><header><h2>最新公告</h2><NuxtLink to="/console/announcements">查看全部</NuxtLink></header><div class="announcement-feed"><article v-for="item in data.announcements.slice(0, 5)" :key="item.id" :data-tone="item.tone"><IconBell :size="18" /><div><strong>{{ item.title }}</strong><p>{{ item.content }}</p></div><time>{{ date(item.publishedAt) }}</time></article></div></section>
      <InlineNotice v-if="expiringKeys.length" tone="info" title="Key 即将到期" :message="expiringKeys.map(key => `${key.name}：${new Date(key.expiresAt!).toLocaleString('zh-CN')}`).join('；')" />
      <section class="admin-metrics"><article v-for="(period, id) in data.periods" :key="id"><span><IconTimeline :size="17" />{{ id === 'today' ? '今日' : id === 'week' ? '本周' : '本月' }}</span><strong>{{ compact(period.requests) }}</strong><small>{{ formatTokenCount(period.tokens) }} Token · {{ money(period.cost) }}</small></article><article><span><IconKey :size="17" />可用 Key</span><strong>{{ data.keys.filter(key => key.status === 'active').length }}</strong><small>共 {{ data.keys.length }} 个</small></article></section>
      <section class="console-overview-grid">
        <article class="admin-panel plan-overview"><header><div><span>SUBSCRIPTION</span><h2>当前套餐</h2></div><IconCoin :size="18" /></header><div v-if="data.plan" class="plan-overview__body"><div><strong>{{ data.plan.plan.name }}</strong><span class="status-label" :data-status="data.plan.status === 'active' ? 'active' : 'disabled'">{{ data.plan.status === 'active' ? '有效' : '不可用' }}</span></div><p>{{ data.plan.plan.description || '无套餐说明' }}</p><dl><div><dt>周期</dt><dd>{{ data.plan.plan.cycle === 'week' ? '7 天' : data.plan.plan.cycle === 'month' ? '1 个月' : '长期' }}</dd></div><div><dt>到期</dt><dd>{{ date(data.plan.expiresAt) }}</dd></div><div><dt>额度</dt><dd>{{ data.plan.plan.mode === 'unlimited' ? '不限量' : data.plan.plan.mode === 'token' ? `${formatTokenCount(Number(data.plan.plan.tokenLimit || 0))} Token` : money(Number(data.plan.plan.costLimit || 0)) }}</dd></div></dl><div v-if="planUsage" class="quota-progress"><div><span>已使用</span><strong>{{ data.plan.plan.mode === 'token' ? `${formatTokenCount(planUsage.used)} Token` : money(planUsage.used) }}</strong></div><i><b :style="{ width: `${planUsage.percent}%` }" /></i><small>剩余 {{ data.plan.plan.mode === 'token' ? `${formatTokenCount(Math.max(0, planUsage.limit - planUsage.used))} Token` : money(Math.max(0, planUsage.limit - planUsage.used)) }}</small></div></div><div v-else class="admin-empty">当前没有套餐</div></article>
        <article class="admin-panel"><header><div><span>ACCESS</span><h2>我的 Keys</h2></div><IconKey :size="18" /></header><div v-if="data.keys.length" class="summary-list"><div v-for="key in data.keys.slice(0, 5)" :key="key.id"><span class="status-label" :data-status="key.status">{{ key.status === 'active' ? '启用' : '停用' }}</span><div><strong>{{ key.name }}</strong><code>{{ key.maskedKey }}</code></div><small>{{ key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString('zh-CN') : '尚未使用' }}</small></div></div><div v-else class="admin-empty console-empty"><p>还没有 Hub Key</p><NuxtLink to="/console/keys" class="button button--primary button--small">创建 Key</NuxtLink></div><NuxtLink v-if="data.keys.length" to="/console/keys" class="admin-text-link">管理我的 Keys</NuxtLink></article>
        <article class="admin-panel"><header><div><span>MODELS</span><h2>可用模型</h2></div><IconBraces :size="18" /></header><div v-if="data.models.length" class="summary-list summary-list--models"><div v-for="model in data.models.slice(0, 8)" :key="model.id"><code>{{ model.id }}</code><small>{{ model.endpoints.length }} 个端点</small></div></div><div v-else class="admin-empty">没有健康渠道支持的模型</div><NuxtLink to="/console/models" class="admin-text-link">查看全部模型</NuxtLink></article>
        <article class="admin-panel service-panel"><header><div><span>SERVICE</span><h2>渠道状态</h2></div><IconServer :size="18" /></header><div class="service-panel__body"><strong>{{ data.service.healthyChannels }}</strong><span>健康渠道</span><p>{{ data.service.enabledChannels ? `共启用 ${data.service.enabledChannels} 个渠道` : '当前没有启用渠道' }}</p></div></article>
      </section>
    </template>
    <ConsoleAnnouncementDialog
      :open="announcementDialogOpen"
      :announcements="data?.announcements || []"
      @close="closeAnnouncements"
      @dismiss-today="dismissAnnouncementsToday"
    />
  </div>
</template>
