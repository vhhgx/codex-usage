<script setup lang="ts">
import { IconChevronLeft, IconChevronRight, IconCode, IconRefresh, IconX } from '@tabler/icons-vue'
import JsonTree from '~/components/admin/JsonTree.vue'
import type { RequestLogView } from '#shared/types/hub'
import { extractLogImages, parseLogBodyContent, reconstructLogMessages, reconstructLogRequestMessages } from '#shared/utils/admin-log-view'
import { formatTokenCount } from '#shared/utils/number-format'
import { requestModelMapping } from '#shared/utils/request-log'

definePageMeta({ layout: 'console', middleware: 'user' })
useSeoMeta({ title: '请求记录 | Zephyr Hub' })

interface BodyView { contentType: string; encoding: string; content: string }
interface AttemptView { id: number; attempt: number; status: string; httpStatus: number | null; durationMs: number | null; errorMessage: string | null; resourceNameSnapshot: string | null; executionNameSnapshot: string | null; failureClass: string | null }
interface Detail extends Record<string, unknown> { requestId: string; resourceType: RequestLogView['resourceType']; resourceName: string | null; executionName: string | null; requestBody: BodyView | null; responseBody: BodyView | null; requestBodyHash: string | null; responseBodyHash: string | null; attempts: AttemptView[] }

const page = ref(1)
const { data, refresh, status: logsStatus } = await useFetch<{ items: RequestLogView[]; page: number; pageSize: number; total: number }>('/api/console/logs', { query: computed(() => ({ page: page.value, pageSize: 50 })) })
watch(page, () => refresh())
const maxPage = computed(() => Math.max(1, Math.ceil((data.value?.total || 0) / 50)))
const detail = ref<Detail | null>(null)
const dateTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Shanghai' })

async function open(item: RequestLogView) { detail.value = await $fetch<Detail>(`/api/console/logs/${item.id}`) }
function parsed(body: BodyView | null) { if (!body || body.encoding === 'base64') return null; const result = parseLogBodyContent(body.content, body.contentType); return result.parsed ? result.value : null }
const requestJson = computed(() => parsed(detail.value?.requestBody || null))
const responseJson = computed(() => parsed(detail.value?.responseBody || null))
const requestMessages = computed(() => reconstructLogRequestMessages(requestJson.value))
const responseMessages = computed(() => reconstructLogMessages(responseJson.value))
const images = computed(() => extractLogImages(responseJson.value))
const time = (value: number) => dateTime.format(value)
const money = (value: number) => `$${value.toFixed(value < 1 ? 6 : 2)}`
const resourceType = (value: RequestLogView['resourceType']) => ({ subscription: '平台套餐', user_relay: '个人中转', private_pool: '专属号池', unresolved: '未选路' })[value]
</script>

<template>
  <div class="admin-page admin-page--logs">
    <header class="admin-page__header"><div><span class="admin-kicker">MY REQUESTS</span><h1>请求记录</h1><p>只显示归属于你的 Key 的调用记录。</p></div><button class="button button--secondary button--small" :disabled="logsStatus === 'pending'" @click="refresh()"><IconRefresh :class="{ 'is-spinning': logsStatus === 'pending' }" :size="15" />刷新</button></header>
    <section class="admin-table-wrap"><table class="admin-table admin-table--logs"><thead><tr><th>时间 / 请求 ID</th><th>Key</th><th>模型 / 端点</th><th>资源 / 执行节点</th><th>状态</th><th>Token</th><th>成本</th><th>耗时</th></tr></thead><tbody>
      <tr v-for="item in data?.items || []" :key="item.id" @click="open(item)">
        <td><strong>{{ time(item.createdAt) }}</strong><code>{{ item.requestId }}</code></td>
        <td>{{ item.keyName || '已删除 Key' }}</td>
        <td><code>{{ item.requestedModel || '—' }}</code><small v-if="requestModelMapping(item.requestedModel, item.upstreamModel)">映射：{{ requestModelMapping(item.requestedModel, item.upstreamModel) }}</small><small>{{ item.endpoint.replace('/v1/', '') }}<template v-if="item.reasoningEffort"> · 推理：{{ item.reasoningEffort }}</template></small></td>
        <td><strong>{{ item.resourceName || '未选路' }}</strong><small>{{ resourceType(item.resourceType) }}<template v-if="item.executionName"> · {{ item.executionName }}</template></small></td>
        <td><span class="status-dot" :data-status="item.status"><i />{{ item.httpStatus || '—' }}</span></td>
        <td>{{ formatTokenCount(item.totalTokens) }}</td><td>{{ money(item.cost) }}</td><td>{{ item.durationMs === null ? '—' : `${item.durationMs}ms` }}</td>
      </tr>
      <tr v-if="!data?.items.length"><td colspan="8"><div class="admin-empty">尚无请求记录</div></td></tr>
    </tbody></table></section>
    <footer class="admin-pagination"><button class="icon-button" title="上一页" aria-label="上一页" :disabled="page <= 1" @click="page--"><IconChevronLeft :size="18" /></button><span>第 {{ page }} / {{ maxPage }} 页</span><button class="icon-button" title="下一页" aria-label="下一页" :disabled="page >= maxPage" @click="page++"><IconChevronRight :size="18" /></button></footer>

    <div v-if="detail" class="log-drawer-backdrop" @click.self="detail = null"><aside class="log-drawer"><header><div><span>REQUEST DETAIL</span><code>{{ detail.requestId }}</code></div><button class="icon-button" title="关闭" aria-label="关闭" @click="detail = null"><IconX :size="18" /></button></header>
      <section class="console-log-resource"><div><span>使用资源</span><strong>{{ detail.resourceName || '未选路' }}</strong><small>{{ resourceType(detail.resourceType) }}</small></div><div><span>执行节点</span><strong>{{ detail.executionName || '未执行' }}</strong><small>实际渠道 / 中转账号</small></div></section>
      <section class="log-body"><header><IconCode :size="17" /><h3>用户输入</h3></header><div v-if="requestMessages.length" class="log-messages"><article v-for="message in requestMessages" :key="message.id"><header><strong>{{ message.label }}</strong></header><pre>{{ message.content }}</pre></article></div><div v-else class="admin-empty">没有可整理的用户文本</div></section>
      <section class="log-body"><header><IconCode :size="17" /><h3>助手响应</h3></header><div v-if="responseMessages.length" class="log-messages"><article v-for="message in responseMessages" :key="message.id"><header><strong>{{ message.label }}</strong></header><pre>{{ message.content }}</pre></article></div><div v-else class="admin-empty">没有可拼接的响应文本</div></section>
      <section class="log-body"><header><h3>原始请求 JSON</h3></header><JsonTree v-if="requestJson !== null" :value="requestJson" /><pre v-else>{{ detail.requestBody?.content || '正文不可用' }}</pre></section>
      <section class="log-body"><header><h3>原始响应 JSON</h3></header><JsonTree v-if="responseJson !== null" :value="responseJson" /><pre v-else>{{ detail.responseBody?.content || '正文不可用' }}</pre><div v-if="images.length" class="log-images"><header><h4>生成图片</h4><span>{{ images.length }} 张</span></header><div><a v-for="(image, index) in images" :key="index" :href="image.src" target="_blank"><img :src="image.src" :alt="`生成图片 ${index + 1}`"></a></div></div></section>
      <section v-if="detail.attempts.length" class="log-attempts"><h3>调度轨迹</h3><div v-for="attempt in detail.attempts" :key="attempt.id"><span>{{ attempt.attempt }}</span><strong>{{ attempt.resourceNameSnapshot || detail.resourceName || '未记录资源' }}<small v-if="attempt.executionNameSnapshot"> · {{ attempt.executionNameSnapshot }}</small></strong><code>{{ attempt.httpStatus || '网络错误' }}</code><small>{{ attempt.durationMs === null ? '—' : `${attempt.durationMs}ms` }}<template v-if="attempt.failureClass"> · {{ attempt.failureClass }}</template></small><p v-if="attempt.errorMessage">{{ attempt.errorMessage }}</p></div></section>
    </aside></div>
  </div>
</template>

<style scoped>
.console-log-resource { padding:1rem; border-bottom:1px solid var(--line-subtle); display:grid; grid-template-columns:1fr 1fr; gap:.75rem; }
.console-log-resource > div { min-width:0; padding:.7rem; border:1px solid var(--line-subtle); display:grid; gap:.2rem; background:var(--surface-soft); }
.console-log-resource span,.console-log-resource small { color:var(--text-muted); font-size:.68rem; }
.console-log-resource strong { overflow:hidden; font-size:.8rem; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:640px) { .console-log-resource { grid-template-columns:1fr; } }
</style>
