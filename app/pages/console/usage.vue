<script setup lang="ts">
import { IconBraces, IconCoin, IconKey, IconTimeline } from '@tabler/icons-vue'
import type { HubKeyUsagePeriod, HubKeyView, RequestLogView } from '#shared/types/hub'
import { formatTokenCount } from '#shared/utils/number-format'
definePageMeta({ layout:'console', middleware:'user' })
useSeoMeta({ title:'我的用量 | Zephyr Hub' })
interface Item { key:HubKeyView; periods:HubKeyUsagePeriod[]; recentRequests:RequestLogView[] }
const { data } = await useFetch<{keys:Item[]}>('/api/console/usage')
const compact=(v:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:2}).format(v)
const money=(v:number)=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'USD',maximumFractionDigits:v<1?4:2}).format(v)
const label=(id:string)=>({all:'全部',today:'今日',week:'本周',month:'本月'}[id]||id)
function limit(key:HubKeyView,id:string,metric:'Request'|'Token'|'Cost'){const prefix=id==='all'?'total':id==='today'?'daily':id==='week'?'weekly':'monthly';return key[`${prefix}${metric}Limit` as keyof HubKeyView] as number|null}
</script>
<template><div class="admin-page"><header class="admin-page__header"><div><span class="admin-kicker">MY USAGE</span><h1>我的用量</h1><p>按 Key 查看请求、Token、成本和周期额度。</p></div></header><section v-for="item in data?.keys||[]" :key="item.key.id" class="key-activity-panel"><header class="key-activity-header"><div><span>{{ item.key.groupName }}</span><h2>{{ item.key.name }}</h2><small><code>{{ item.key.maskedKey }}</code></small></div><span class="status-dot" :data-status="item.key.status"><i />{{ item.key.status }}</span></header><div class="key-usage-periods"><article v-for="period in item.periods" :key="period.id"><header><strong>{{ label(period.id) }}</strong><span>{{ period.successRate===null?'—':`${period.successRate.toFixed(1)}%` }}</span></header><dl><div><dt><IconTimeline :size="14" />请求</dt><dd>{{ compact(period.admittedRequests) }}<small> / {{ limit(item.key,period.id,'Request')===null?'∞':compact(limit(item.key,period.id,'Request')!) }}</small></dd></div><div><dt><IconBraces :size="14" />Token</dt><dd>{{ formatTokenCount(period.tokens) }}<small> / {{ limit(item.key,period.id,'Token')===null?'∞':formatTokenCount(limit(item.key,period.id,'Token')!) }}</small></dd></div><div><dt><IconCoin :size="14" />成本</dt><dd>{{ money(period.cost) }}<small> / {{ limit(item.key,period.id,'Cost')===null?'∞':money(limit(item.key,period.id,'Cost')!) }}</small></dd></div></dl></article></div></section><div v-if="!data?.keys.length" class="admin-empty admin-empty--large console-empty"><div><IconKey :size="24" /><p>当前没有可统计的 Key</p><NuxtLink class="button button--primary button--small" to="/console/keys">创建 Key</NuxtLink></div></div></div></template>
