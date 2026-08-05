<script setup lang="ts">
import { IconBraces, IconCoin, IconRoute, IconShieldCheck, IconUsersGroup } from '@tabler/icons-vue'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '权限与额度 | Zephyr Hub' })
interface Period { requests: number; tokens: number; cost: number }
interface Group { id: string; name: string; description: string | null; status: string; allowedEndpoints: string[]; rpmLimit: number | null; concurrencyLimit: number | null; dailyRequestLimit: number | null; dailyTokenLimit: number | null; dailyCostLimit: number | null; weeklyRequestLimit: number | null; weeklyTokenLimit: number | null; weeklyCostLimit: number | null; monthlyRequestLimit: number | null; monthlyTokenLimit: number | null; monthlyCostLimit: number | null; priceMultiplier: number; usage: { requests: number; tokens: number; cost: number; today: Period; week: Period; month: Period } }
interface Subscription { status: string; startsAt: number; expiresAt: number | null; plan: { name: string; description: string | null; mode: 'unlimited' | 'token' | 'cost'; cycle: string; tokenLimit: number | null; costLimit: number | null; price: number }; usage: { requests: number; tokens: number; cost: number } }
const [{ data: groupData }, { data: planData }] = await Promise.all([useFetch<{ groups: Group[] }>('/api/console/groups'), useFetch<{ subscription: Subscription | null }>('/api/console/plan')])
const group = computed(() => groupData.value?.groups[0] || null)
const plan = computed(() => planData.value?.subscription || null)
const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
const money = (value: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)
const limit = (value: number | null, type: 'number' | 'money' | 'token' = 'number') => value === null ? '不限' : type === 'money' ? money(value) : type === 'token' ? formatTokenCount(value) : compact(value)
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(value) : '长期有效'
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">ACCESS & QUOTA</span><h1>权限与额度</h1><p>默认分组决定可访问的渠道、模型与请求保护；套餐决定个人可用额度和有效期。</p></div></header>
    <section class="access-layout">
      <article class="admin-panel access-policy"><header><div><span>ADMIN CONTROLLED</span><h2>{{ group?.name || '默认分组' }}</h2></div><span class="status-label" :data-status="group?.status || 'disabled'">{{ group?.status === 'active' ? '权限生效' : '权限停用' }}</span></header><template v-if="group"><div class="access-policy__intro"><IconShieldCheck :size="22" /><p>{{ group.description || '管理员统一配置的用户权限范围。' }}</p></div><dl class="access-facts"><div><dt><IconUsersGroup :size="16" />请求速率</dt><dd>{{ limit(group.rpmLimit) }} RPM</dd></div><div><dt><IconRoute :size="16" />最大并发</dt><dd>{{ limit(group.concurrencyLimit) }}</dd></div><div><dt><IconBraces :size="16" />端点权限</dt><dd>{{ group.allowedEndpoints.length ? `${group.allowedEndpoints.length} 个指定端点` : '全部端点' }}</dd></div><div><dt><IconCoin :size="16" />价格倍率</dt><dd>{{ group.priceMultiplier }}×</dd></div></dl><div v-if="group.allowedEndpoints.length" class="endpoint-tags"><code v-for="endpoint in group.allowedEndpoints" :key="endpoint">{{ endpoint }}</code></div></template><div v-else class="admin-empty">默认分组尚未配置</div></article>
      <article class="admin-panel access-plan"><header><div><span>MY PLAN</span><h2>{{ plan?.plan.name || '未分配套餐' }}</h2></div><IconCoin :size="18" /></header><template v-if="plan"><div class="access-plan__summary"><strong>{{ plan.plan.mode === 'unlimited' ? '不限量' : plan.plan.mode === 'token' ? `${formatTokenCount(Number(plan.plan.tokenLimit || 0))} Token` : money(Number(plan.plan.costLimit || 0)) }}</strong><span class="status-label" :data-status="plan.status === 'active' ? 'active' : 'disabled'">{{ plan.status === 'active' ? '有效' : plan.status === 'expired' ? '已到期' : '不可用' }}</span><p>{{ plan.plan.description || '无套餐说明' }}</p></div><dl class="access-facts"><div><dt>生效日期</dt><dd>{{ date(plan.startsAt) }}</dd></div><div><dt>到期日期</dt><dd>{{ date(plan.expiresAt) }}</dd></div><div><dt>已用 Token</dt><dd>{{ formatTokenCount(plan.usage.tokens) }}</dd></div><div><dt>已用金额</dt><dd>{{ money(plan.usage.cost) }}</dd></div></dl></template><div v-else class="admin-empty">当前没有有效套餐</div></article>
      <article v-if="group" class="admin-panel access-periods"><header><div><span>GROUP LIMITS</span><h2>分组共享限制</h2></div></header><div class="period-limit-grid"><article v-for="item in [{ key: 'today', label: '今日', prefix: 'daily' }, { key: 'week', label: '本周', prefix: 'weekly' }, { key: 'month', label: '本月', prefix: 'monthly' }]" :key="item.key"><h3>{{ item.label }}</h3><dl><div><dt>请求</dt><dd>{{ compact(group.usage[item.key as 'today' | 'week' | 'month'].requests) }} / {{ limit(group[`${item.prefix}RequestLimit` as keyof Group] as number | null) }}</dd></div><div><dt>Token</dt><dd>{{ formatTokenCount(group.usage[item.key as 'today' | 'week' | 'month'].tokens) }} / {{ limit(group[`${item.prefix}TokenLimit` as keyof Group] as number | null, 'token') }}</dd></div><div><dt>金额</dt><dd>{{ money(group.usage[item.key as 'today' | 'week' | 'month'].cost) }} / {{ limit(group[`${item.prefix}CostLimit` as keyof Group] as number | null, 'money') }}</dd></div></dl></article></div></article>
    </section>
  </div>
</template>
