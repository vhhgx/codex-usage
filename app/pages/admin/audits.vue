<script setup lang="ts">
import { IconChevronLeft, IconChevronRight, IconSearch, IconShieldCheck, IconX } from '@tabler/icons-vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '审计日志 | Zephyr Hub' })

interface AuditItem {
  id: number
  username: string
  action: string
  targetType: string
  targetId: string | null
  detail: Record<string, unknown>
  ipHash: string | null
  createdAt: number
}

const page = ref(1)
const search = ref('')
const action = ref('')
const targetType = ref('')
const from = ref('')
const to = ref('')
const selected = ref<AuditItem | null>(null)
const query = computed(() => ({ page: page.value, pageSize: 50, search: search.value || undefined, action: action.value || undefined, targetType: targetType.value || undefined, from: from.value ? new Date(from.value).toISOString() : undefined, to: to.value ? new Date(to.value).toISOString() : undefined }))
const { data, refresh } = await useFetch<{ items: AuditItem[]; total: number; page: number; pageSize: number }>('/api/admin/audits', { query })
const maxPage = computed(() => Math.max(1, Math.ceil((data.value?.total || 0) / 50)))
let timer: ReturnType<typeof setTimeout>
watch([search, action, targetType, from, to], () => { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; void refresh() }, 300) })
watch(page, () => { void refresh() })
onBeforeUnmount(() => clearTimeout(timer))

function time(value: number) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) }
function detail(value: Record<string, unknown>) { return Object.keys(value).length ? JSON.stringify(value, null, 2) : '{}' }
</script>

<template>
  <div class="admin-page admin-page--logs">
    <header class="admin-page__header"><div><span class="admin-kicker">CONTROL HISTORY</span><h1>审计日志</h1><p>管理员操作、配置变更和敏感数据访问记录。</p></div><span class="audit-total"><IconShieldCheck :size="17" />{{ data?.total || 0 }} 条</span></header>
    <section class="admin-toolbar admin-toolbar--filters audit-filters"><label class="admin-search"><IconSearch :size="17" /><input v-model="search" placeholder="管理员、操作或目标 ID"></label><input v-model="action" placeholder="操作，例如 hub_key"><AppSelect v-model="targetType"><option value="">全部目标</option><option value="hub_key">Hub Key</option><option value="channel">渠道</option><option value="model">模型</option><option value="request_log">请求日志</option><option value="system">系统</option></AppSelect><input v-model="from" type="datetime-local" aria-label="开始时间"><input v-model="to" type="datetime-local" aria-label="结束时间"></section>
    <section class="admin-table-wrap"><table class="admin-table audit-table"><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>目标</th><th>IP 哈希</th><th>详情</th></tr></thead><tbody><tr v-for="item in data?.items || []" :key="item.id" @click="selected = item"><td>{{ time(item.createdAt) }}</td><td><strong>{{ item.username }}</strong></td><td><code>{{ item.action }}</code></td><td><span>{{ item.targetType }}</span><code>{{ item.targetId || '—' }}</code></td><td><code>{{ item.ipHash || '—' }}</code></td><td><small>{{ Object.keys(item.detail).length }} 字段</small></td></tr><tr v-if="!data?.items.length"><td colspan="6"><div class="admin-empty">没有匹配的审计记录</div></td></tr></tbody></table></section>
    <footer class="admin-pagination"><button class="icon-button" title="上一页" aria-label="上一页" :disabled="page <= 1" @click="page--"><IconChevronLeft :size="18" /></button><span>第 {{ page }} / {{ maxPage }} 页</span><button class="icon-button" title="下一页" aria-label="下一页" :disabled="page >= maxPage" @click="page++"><IconChevronRight :size="18" /></button></footer>
    <div v-if="selected" class="log-drawer-backdrop" @click.self="selected = null"><aside class="log-drawer audit-drawer"><header><div><span>AUDIT DETAIL</span><code>#{{ selected.id }} · {{ selected.action }}</code></div><button class="icon-button" title="关闭" aria-label="关闭" @click="selected = null"><IconX :size="18" /></button></header><section><dl><div><dt>管理员</dt><dd>{{ selected.username }}</dd></div><div><dt>时间</dt><dd>{{ time(selected.createdAt) }}</dd></div><div><dt>目标</dt><dd>{{ selected.targetType }} · {{ selected.targetId || '—' }}</dd></div><div><dt>IP 哈希</dt><dd><code>{{ selected.ipHash || '—' }}</code></dd></div></dl><pre>{{ detail(selected.detail) }}</pre></section></aside></div>
  </div>
</template>
