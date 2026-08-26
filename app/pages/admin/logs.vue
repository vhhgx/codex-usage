<script setup lang="ts">
import { IconChevronLeft, IconChevronRight, IconCode, IconSearch, IconX } from '@tabler/icons-vue'
import JsonTree from '~/components/admin/JsonTree.vue'
import type { ChannelView, HubKeyView, RequestLogView } from '#shared/types/hub'
import { queryString } from '#shared/utils/admin-log-query'
import { base64ByteLength, extractLogImages, formatByteSize, parseLogBodyContent, reconstructLogMessages, reconstructLogRequestMessages } from '#shared/utils/admin-log-view'
import { formatTokenCount } from '#shared/utils/number-format'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '请求日志 | Zephyr Hub' })

interface BodyView { contentType: string; encoding: string; content: string }
interface Detail extends Record<string, unknown> { requestId: string; endpoint: string; status: string; requestBodyHash: string | null; responseBodyHash: string | null; requestBody: BodyView | null; responseBody: BodyView | null; attempts: Array<{ id: number; attempt: number; status: string; httpStatus: number | null; durationMs: number | null; errorMessage: string | null; resourceNameSnapshot: string | null; executionNameSnapshot: string | null; failureClass: string | null }> }
const route = useRoute()
const page = ref(Math.max(1, Number.parseInt(queryString(route.query.page)) || 1))
const search = ref(queryString(route.query.search))
const status = ref(queryString(route.query.status))
const model = ref(queryString(route.query.model))
const endpoint = ref(queryString(route.query.endpoint))
const keyId = ref(queryString(route.query.keyId))
const channelId = ref(queryString(route.query.channelId))
const resourceTypeFilter = ref(queryString(route.query.resourceType))
const resourceId = ref(queryString(route.query.resourceId))
const from = ref(queryString(route.query.from))
const to = ref(queryString(route.query.to))
const query = computed(() => ({ page: page.value, pageSize: 50, search: search.value || undefined, status: status.value || undefined, model: model.value || undefined, endpoint: endpoint.value || undefined, keyId: keyId.value || undefined, channelId: channelId.value || undefined, resourceType: resourceTypeFilter.value || undefined, resourceId: resourceId.value || undefined, from: from.value || undefined, to: to.value || undefined }))
interface LogStats { requests: number; tokens: number; cost: number }
interface ResourceStat extends LogStats { type: RequestLogView['resourceType']; id: string | null; name: string }
interface ExecutionStat extends LogStats { channelId: string | null; name: string }
const { data, refresh } = await useFetch<{ items: RequestLogView[]; page: number; pageSize: number; total: number; resourceStats: ResourceStat[]; executionStats: ExecutionStat[] }>('/api/admin/logs', { query })
const { data: keyData } = await useFetch<{ keys: HubKeyView[] }>('/api/admin/keys')
const { data: channelData } = await useFetch<{ channels: ChannelView[] }>('/api/admin/channels')
const detail = ref<Detail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const maxPage = computed(() => Math.max(1, Math.ceil((data.value?.total || 0) / 50)))
let timer: ReturnType<typeof setTimeout>
watch(resourceTypeFilter, () => { resourceId.value = '' })
watch([search, status, model, endpoint, keyId, channelId, resourceTypeFilter, resourceId, from, to], () => { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; refresh() }, 300) })
watch(page, () => refresh())
onBeforeUnmount(() => clearTimeout(timer))

function time(value: number) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) }
function money(value: number) { return `$${value.toFixed(value < 1 ? 6 : 2)}` }
function resourceType(value: RequestLogView['resourceType']) { return ({ subscription: '平台套餐', user_relay: '个人中转', private_pool: '专属号池', unresolved: '未选路' })[value] }
const rangeLabel = computed(() => from.value && to.value ? `${time(new Date(from.value).getTime())} - ${time(new Date(to.value).getTime())}` : '')
async function open(item: RequestLogView) {
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  try {
    detail.value = await $fetch<Detail>(`/api/admin/logs/${item.id}`)
  } catch (error) {
    detailError.value = error instanceof Error ? error.message : '请求详情加载失败'
  } finally {
    detailLoading.value = false
  }
}
function closeDetail() { detail.value = null; detailError.value = '' }

interface BodyPresentation { kind: 'empty' | 'json' | 'text' | 'binary'; value?: unknown; text?: string; images: Array<{ src: string; label: string }>; messages: Array<{ id: string; label: string; content: string; parts: number }> }
function presentBody(body: BodyView | null, direction: 'request' | 'response'): BodyPresentation {
  if (!body) return { kind: 'empty', text: '正文不存在、已过期或对象存储暂不可用。', images: [], messages: [] }
  if (body.encoding === 'base64') {
    const images = body.contentType.startsWith('image/') ? [{ src: `data:${body.contentType};base64,${body.content}`, label: '响应图片' }] : []
    return { kind: 'binary', text: `${body.contentType} · Base64 · ${formatByteSize(base64ByteLength(body.content))}`, images, messages: [] }
  }
  const parsed = parseLogBodyContent(body.content, body.contentType)
  if (parsed.parsed) return {
    kind: 'json',
    value: parsed.value,
    images: extractLogImages(parsed.value),
    messages: direction === 'request' ? reconstructLogRequestMessages(parsed.value) : reconstructLogMessages(parsed.value)
  }
  return { kind: 'text', text: body.content, images: [], messages: [] }
}
const requestBody = computed(() => presentBody(detail.value?.requestBody || null, 'request'))
const responseBody = computed(() => presentBody(detail.value?.responseBody || null, 'response'))
const userMessages = computed(() => requestBody.value.messages.filter(message => !/系统|开发者|工具/.test(message.label)))
const assistantMessages = computed(() => responseBody.value.messages.filter(message => !message.label.includes('工具')))
const toolMessages = computed(() => [...requestBody.value.messages, ...responseBody.value.messages].filter(message => message.label.includes('工具')))
const contextMessages = computed(() => requestBody.value.messages.filter(message => /系统|开发者/.test(message.label)))
const responseMessageNotice = computed(() => {
  if (detail.value?.status === 'stream_aborted' && responseBody.value.messages.length) return '响应流已中断，以下内容仅由中断前收到的片段拼接。'
  const textEndpoint = detail.value?.endpoint === '/v1/responses' || detail.value?.endpoint === '/v1/chat/completions'
  if (textEndpoint && responseBody.value.kind === 'json' && !responseBody.value.messages.length && !responseBody.value.images.length) {
    return '未发现可拼接的文本。响应可能只包含工具事件，或上游返回了非标准、截断的事件格式；可在下方原始响应树中核对。'
  }
  return ''
})
</script>

<template>
  <div class="admin-page admin-page--logs">
    <header class="admin-page__header"><div><span class="admin-kicker">REQUEST FORENSICS</span><h1>请求日志</h1><p>逐次查看模型、渠道、Token、耗时、错误和完整审计正文。</p></div></header>
    <section class="admin-toolbar admin-toolbar--filters"><label class="admin-search"><IconSearch :size="17" /><input v-model="search" placeholder="请求 ID 或错误信息"></label><AppSelect v-model="keyId"><option value="">全部 Keys</option><option v-for="item in keyData?.keys || []" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect><AppSelect v-model="resourceTypeFilter"><option value="">全部资源类型</option><option value="subscription">平台套餐</option><option value="user_relay">个人中转</option><option value="private_pool">专属号池</option><option value="unresolved">未选路</option></AppSelect><AppSelect v-model="resourceId"><option value="">全部资源实例</option><option v-for="item in data?.resourceStats.filter(stat => stat.id) || []" :key="`${item.type}:${item.id}`" :value="item.id!">{{ item.name }}</option></AppSelect><AppSelect v-model="channelId"><option value="">全部执行账号 / 渠道</option><option v-for="item in channelData?.channels || []" :key="item.id" :value="item.id">{{ item.name }}</option></AppSelect><input v-model="model" placeholder="模型名称"><AppSelect v-model="endpoint"><option value="">全部端点</option><option value="/v1/chat/completions">Chat Completions</option><option value="/v1/responses">Responses</option><option value="/v1/embeddings">Embeddings</option><option value="/v1/images/generations">Images Generations</option><option value="/v1/images/edits">Images Edits</option></AppSelect><AppSelect v-model="status"><option value="">全部状态</option><option value="success">成功</option><option value="error">错误</option><option value="stream_aborted">流中断</option><option value="pending">进行中</option></AppSelect><button v-if="rangeLabel" class="button button--quiet button--small" :title="rangeLabel" @click="from = ''; to = ''"><IconX :size="14" /> 清除时段</button><span>{{ data?.total || 0 }} 条记录</span></section>
    <section v-if="data?.resourceStats.length || data?.executionStats.length" class="log-resource-stats"><span v-for="item in data?.resourceStats.slice(0, 4) || []" :key="`${item.type}:${item.id}:${item.name}`"><strong>{{ item.name }}</strong><small>{{ resourceType(item.type) }} · {{ item.requests }} 次 · {{ formatTokenCount(item.tokens) }} Token · {{ money(item.cost) }}</small></span><i v-if="data?.resourceStats.length && data?.executionStats.length" /><span v-for="item in data?.executionStats.slice(0, 4) || []" :key="`execution:${item.channelId}:${item.name}`"><strong>{{ item.name }}</strong><small>执行节点 · {{ item.requests }} 次 · {{ formatTokenCount(item.tokens) }} Token · {{ money(item.cost) }}</small></span></section>
    <section class="admin-table-wrap"><table class="admin-table admin-table--logs"><thead><tr><th>时间 / 请求 ID</th><th>Key</th><th>模型 / 端点</th><th>资源 / 执行节点</th><th>状态</th><th>Token</th><th>成本</th><th title="总耗时：Hub 收到请求至请求完成；首字节：Hub 收到请求至上游返回第一段响应数据">耗时</th></tr></thead><tbody>
      <tr v-for="item in data?.items || []" :key="item.id" @click="open(item)"><td><strong>{{ time(item.createdAt) }}</strong><code>{{ item.requestId }}</code></td><td>{{ item.keyName || '已删除 Key' }}</td><td><code>{{ item.requestedModel || '—' }}</code><small>{{ item.endpoint.replace('/v1/', '') }}</small></td><td><strong>{{ item.resourceName || '未选路' }}</strong><small>{{ resourceType(item.resourceType) }}<template v-if="item.executionName"> · {{ item.executionName }}</template></small></td><td><span class="status-dot" :data-status="item.status"><i />{{ item.httpStatus || '—' }}</span></td><td>{{ formatTokenCount(item.totalTokens) }}</td><td>{{ money(item.cost) }}</td><td><span class="log-duration">{{ item.durationMs === null ? '—' : `${item.durationMs}ms` }}<small v-if="item.firstByteMs !== null">首字节 {{ item.firstByteMs }}ms</small></span></td></tr>
      <tr v-if="!data?.items.length"><td colspan="8"><div class="admin-empty">没有匹配的请求日志</div></td></tr>
    </tbody></table></section>
    <footer class="admin-pagination"><button class="icon-button" title="上一页" aria-label="上一页" :disabled="page <= 1" @click="page--"><IconChevronLeft :size="18" /></button><span>第 {{ page }} / {{ maxPage }} 页</span><button class="icon-button" title="下一页" aria-label="下一页" :disabled="page >= maxPage" @click="page++"><IconChevronRight :size="18" /></button></footer>

    <div v-if="detail || detailLoading || detailError" class="log-drawer-backdrop" @click.self="closeDetail"><aside class="log-drawer"><header><div><span>REQUEST DETAIL</span><code>{{ detail?.requestId || (detailError ? '加载失败' : '正在载入…') }}</code></div><button class="icon-button" title="关闭" aria-label="关闭" @click="closeDetail"><IconX :size="18" /></button></header>
      <div v-if="detailError" class="log-detail-error"><strong>无法载入请求详情</strong><p>{{ detailError }}</p></div>
      <template v-if="detail">
        <section class="log-body"><header><IconCode :size="17" /><h3>用户消息</h3></header><div v-if="userMessages.length" class="log-messages"><article v-for="message in userMessages" :key="message.id"><header><strong>{{ message.label }}</strong><small>{{ message.parts > 1 ? `${message.parts} 个内容块` : '完整内容' }}</small></header><pre>{{ message.content }}</pre></article></div><div v-else class="admin-empty">没有可整理的用户文本</div></section>
        <section class="log-body"><header><IconCode :size="17" /><h3>助手响应</h3></header><p v-if="responseMessageNotice" class="log-reconstruction-note">{{ responseMessageNotice }}</p><div v-if="assistantMessages.length" class="log-messages"><article v-for="message in assistantMessages" :key="message.id"><header><strong>{{ message.label }}</strong><small>{{ message.parts > 1 ? `${message.parts} 个片段` : '完整响应' }}</small></header><pre>{{ message.content }}</pre></article></div><div v-else class="admin-empty">没有可拼接的助手文本</div></section>
        <section v-if="toolMessages.length" class="log-body"><header><IconCode :size="17" /><h3>工具调用与结果</h3></header><div class="log-messages"><article v-for="message in toolMessages" :key="message.id"><header><strong>{{ message.label }}</strong></header><pre>{{ message.content }}</pre></article></div></section>
        <details v-if="contextMessages.length" class="log-body log-context"><summary>系统 / 开发者上下文（{{ contextMessages.length }} 段）</summary><div class="log-messages"><article v-for="message in contextMessages" :key="message.id"><header><strong>{{ message.label }}</strong></header><pre>{{ message.content }}</pre></article></div></details>
        <section class="log-body"><header><IconCode :size="17" /><h3>原始请求 JSON</h3><small :title="detail.requestBodyHash || undefined">SHA-256 {{ detail.requestBodyHash?.slice(0, 12) || '—' }} · {{ detail.requestBody?.contentType }}</small></header><JsonTree v-if="requestBody.kind === 'json'" :value="requestBody.value" /><pre v-else>{{ requestBody.text }}</pre></section>
        <section class="log-body"><header><IconCode :size="17" /><h3>原始响应 JSON</h3><small :title="detail.responseBodyHash || undefined">SHA-256 {{ detail.responseBodyHash?.slice(0, 12) || '—' }} · {{ detail.responseBody?.contentType }}</small></header><JsonTree v-if="responseBody.kind === 'json'" :value="responseBody.value" /><pre v-else>{{ responseBody.text }}</pre></section>
        <section v-if="responseBody.images.length" class="log-body"><div class="log-images"><header><h4>生成图片</h4><span>{{ responseBody.images.length }} 张</span></header><div><a v-for="(image, index) in responseBody.images" :key="`${image.label}-${index}`" :href="image.src" target="_blank" rel="noopener noreferrer" title="打开原图"><img :src="image.src" :alt="`生成图片 ${index + 1}`" loading="lazy"><span>{{ index + 1 }}</span></a></div></div></section>
        <section class="log-attempts"><h3>调度轨迹</h3><div v-for="attempt in detail.attempts" :key="attempt.id"><span>{{ attempt.attempt }}</span><strong>{{ attempt.resourceNameSnapshot || '未记录资源' }}<small v-if="attempt.executionNameSnapshot"> · {{ attempt.executionNameSnapshot }}</small></strong><code>{{ attempt.httpStatus || '网络错误' }}</code><small>{{ attempt.durationMs }}ms<template v-if="attempt.failureClass"> · {{ attempt.failureClass }}</template></small><p v-if="attempt.errorMessage">{{ attempt.errorMessage }}</p></div></section>
      </template>
    </aside></div>
  </div>
</template>

<style scoped>
.log-resource-stats { min-height:44px; padding:.5rem .75rem; border-block:1px solid var(--line-subtle); display:flex; align-items:center; gap:1.25rem; overflow-x:auto; background:var(--surface-soft); }
.log-resource-stats > span { flex:none; display:grid; gap:.12rem; }
.log-resource-stats > i { align-self:stretch; width:1px; background:var(--line-strong); }
.log-resource-stats strong { max-width:180px; overflow:hidden; font-size:.72rem; text-overflow:ellipsis; white-space:nowrap; }
.log-resource-stats small { color:var(--text-muted); font-size:.64rem; font-variant-numeric:tabular-nums; white-space:nowrap; }
</style>
