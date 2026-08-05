<script setup lang="ts">
import { IconAlertTriangle, IconBell, IconCheck, IconDatabase, IconDeviceFloppy, IconKey, IconPlayerPause, IconPlayerPlay, IconRefresh, IconSend, IconServer, IconTrash, IconX } from '@tabler/icons-vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: '系统设置 | Zephyr Hub' })

interface SettingsResponse { settings: { timezone: string; bodyRetentionDays: number; metadataRetentionDays: number; defaultTimeoutMs: number; circuitFailureThreshold: number; circuitCooldownMs: number; errorMessageOverrides: Record<string, string> }; infrastructure: Record<string, boolean> }
const { data, refresh } = await useFetch<SettingsResponse>('/api/admin/settings')
interface AlertStatus { configured: boolean; active: Array<{ id: string; title: string; message: string; severity: 'warning' | 'critical' }>; generatedAt: number }
const { data: alerts, refresh: refreshAlerts } = await useFetch<AlertStatus>('/api/admin/alerts')
interface TrafficStatus { enabled: boolean; startedAt: number | null; expiresAt: number | null; reason: string | null; activeRequests: number }
const { data: traffic, refresh: refreshTraffic } = await useFetch<TrafficStatus>('/api/admin/traffic')
const form = reactive({ timezone: 'Asia/Shanghai', bodyRetentionDays: 30, metadataRetentionDays: 365, defaultTimeoutMs: 120000, circuitFailureThreshold: 3, circuitCooldownMs: 30000, errorMessageOverrides: {} as Record<string, string> })
const errorStatuses = [
  { status: '400', label: '400 请求错误' },
  { status: '401', label: '401 上游认证失败' },
  { status: '403', label: '403 上游拒绝访问' },
  { status: '429', label: '429 上游限流' },
  { status: '500', label: '500 上游内部错误' },
  { status: '502', label: '502 网关请求失败' },
  { status: '503', label: '503 上游暂不可用' },
  { status: '504', label: '504 上游超时' }
]
const saving = ref(false)
const reconciling = ref(false)
const maintaining = ref(false)
const testingAlert = ref(false)
const alertResult = ref('')
const changingTraffic = ref(false)
let trafficTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => { trafficTimer = setInterval(() => { void refreshTraffic() }, 5000) })
onBeforeUnmount(() => { if (trafficTimer) clearInterval(trafficTimer) })
const reconcileResult = ref('')
watchEffect(() => {
  if (!data.value) return
  Object.assign(form, data.value.settings, { errorMessageOverrides: { ...data.value.settings.errorMessageOverrides } })
})
const infrastructure = computed(() => [
  { id: 'postgres', label: 'PostgreSQL', detail: '配置、日志与统计事实数据', icon: IconDatabase },
  { id: 'redis', label: 'Redis', detail: '会话、限额、并发与熔断状态', icon: IconServer },
  { id: 'objectStorage', label: 'MinIO / S3', detail: '30 天加密请求响应正文', icon: IconServer },
  { id: 'encryption', label: '加密密钥', detail: '渠道凭据、Hub Key 与正文保护', icon: IconKey }
])
function timestamp(value: number) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) }
async function save() { saving.value = true; try { await $fetch('/api/admin/settings', { method: 'PATCH', body: form }); await refresh() } finally { saving.value = false } }
async function reconcile() {
  reconciling.value = true
  try {
    const result = await $fetch<{ examined: number; reconciled: number }>('/api/admin/maintenance/reconcile', { method: 'POST' })
    reconcileResult.value = `已检查 ${result.examined} 个 Key，对账 ${result.reconciled} 个空闲 Key`
  } finally { reconciling.value = false }
}
async function maintain() {
  maintaining.value = true
  try {
    const result = await $fetch<{ keysExpired: number; bodyObjectsDeleted: number; metadataDeleted: number; bodyCleanupError: string | null }>('/api/admin/maintenance/run', { method: 'POST' })
    reconcileResult.value = result.bodyCleanupError
      ? `维护部分完成：${result.bodyCleanupError}`
      : `已归档 ${result.keysExpired} 个 Key，删除 ${result.bodyObjectsDeleted} 个正文对象和 ${result.metadataDeleted} 条元数据`
    await refresh()
  } finally { maintaining.value = false }
}
async function testAlert() {
  testingAlert.value = true
  alertResult.value = ''
  try {
    await $fetch('/api/admin/alerts/test', { method: 'POST' })
    alertResult.value = '测试告警已送达'
    await refreshAlerts()
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    alertResult.value = failure.data?.message || failure.message || '测试告警发送失败'
  } finally { testingAlert.value = false }
}
async function changeTraffic(enabled: boolean) {
  changingTraffic.value = true
  try {
    await $fetch('/api/admin/traffic', { method: 'POST', body: { enabled, ttlSeconds: 1800, reason: 'admin maintenance' } })
    await refreshTraffic()
  } finally { changingTraffic.value = false }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__header"><div><span class="admin-kicker">SYSTEM POLICY</span><h1>系统设置</h1><p>控制日志生命周期、请求超时和渠道熔断行为。</p></div><button class="button button--primary" :disabled="saving" @click="save"><IconDeviceFloppy :size="17" />{{ saving ? '保存中' : '保存设置' }}</button></header>
    <section class="settings-layout"><article class="admin-panel settings-form"><header><div><span>RUNTIME POLICY</span><h2>网关策略</h2></div></header>
      <div class="form-grid"><label><span>系统时区</span><input v-model="form.timezone"><small>IANA 时区名称</small></label><label><span>默认上游超时</span><input v-model.number="form.defaultTimeoutMs" type="number" min="1000" max="600000"><small>毫秒</small></label></div>
      <div class="form-grid"><label><span>正文保留天数</span><input v-model.number="form.bodyRetentionDays" type="number" min="1" max="365"><small>MinIO/S3 生命周期应保持一致</small></label><label><span>详细元数据保留天数</span><input v-model.number="form.metadataRetentionDays" type="number" min="30" max="3650"><small>聚合统计不会随之删除</small></label></div>
      <div class="form-grid"><label><span>连续失败阈值</span><input v-model.number="form.circuitFailureThreshold" type="number" min="1" max="20"><small>达到后打开熔断器</small></label><label><span>熔断冷却时间</span><input v-model.number="form.circuitCooldownMs" type="number" min="1000" max="600000"><small>毫秒</small></label></div>
    </article>
    <article class="admin-panel infrastructure-panel"><header><div><span>DEPENDENCIES</span><h2>基础设施</h2></div></header><div v-for="item in infrastructure" :key="item.id" class="infra-row"><span><component :is="item.icon" :size="18" /></span><div><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div><em :class="data?.infrastructure[item.id] ? 'ok' : 'bad'"><IconCheck v-if="data?.infrastructure[item.id]" :size="16" /><IconX v-else :size="16" />{{ data?.infrastructure[item.id] ? '已配置' : '未配置' }}</em></div><footer class="reconcile-action"><div><strong>维护与对账</strong><small>{{ reconcileResult || '清理到期数据，并以 PostgreSQL 聚合校准空闲 Key' }}</small></div><div class="maintenance-actions"><button class="button button--quiet button--small" :disabled="maintaining" @click="maintain"><IconTrash :size="15" />{{ maintaining ? '维护中' : '立即维护' }}</button><button class="button button--secondary button--small" :disabled="reconciling" @click="reconcile"><IconRefresh :class="{ 'is-spinning': reconciling }" :size="15" />{{ reconciling ? '对账中' : '立即对账' }}</button></div></footer></article>
    <article class="admin-panel settings-form settings-error-messages"><header><div><span>CLIENT ERRORS</span><h2>客户端错误文案</h2></div></header><div class="error-message-grid"><label v-for="item in errorStatuses" :key="item.status"><span>{{ item.label }}</span><input v-model="form.errorMessageOverrides[item.status]" :placeholder="`留空时透传标准 ${item.status} 错误`" maxlength="500"></label></div></article>
    <article class="admin-panel traffic-panel"><header><div><span>TRAFFIC CONTROL</span><h2>流量排空</h2></div><div class="traffic-panel__actions"><strong :class="traffic?.enabled ? 'draining' : 'accepting'">{{ traffic?.enabled ? '排空中' : '接收流量' }}</strong><button v-if="traffic?.enabled" class="button button--secondary button--small" :disabled="changingTraffic" @click="changeTraffic(false)"><IconPlayerPlay :size="15" />恢复流量</button><button v-else class="button button--quiet button--small" :disabled="changingTraffic" @click="changeTraffic(true)"><IconPlayerPause :size="15" />开始排空</button></div></header><div class="traffic-status"><div><span>活动请求</span><strong>{{ traffic?.activeRequests || 0 }}</strong></div><div><span>自动恢复</span><strong>{{ traffic?.expiresAt ? timestamp(traffic.expiresAt) : '—' }}</strong></div><div><span>原因</span><strong>{{ traffic?.reason || '—' }}</strong></div></div></article>
    <article class="admin-panel alert-panel"><header><div><span>OBSERVABILITY</span><h2>告警状态</h2></div><div class="alert-panel__actions"><em :class="alerts?.configured ? 'ok' : 'bad'"><IconBell :size="15" />{{ alerts?.configured ? 'Webhook 已连接' : 'Webhook 未配置' }}</em><button class="button button--secondary button--small" :disabled="testingAlert || !alerts?.configured" @click="testAlert"><IconSend :size="15" />{{ testingAlert ? '发送中' : '发送测试' }}</button></div></header><div v-if="alerts?.active.length" class="alert-list"><div v-for="alert in alerts.active" :key="alert.id" class="alert-row"><span :class="alert.severity"><IconAlertTriangle :size="17" /></span><div><strong>{{ alert.title }}</strong><small>{{ alert.message }}</small></div><em>{{ alert.severity === 'critical' ? '严重' : '警告' }}</em></div></div><div v-else class="alert-empty"><IconCheck :size="18" /><div><strong>当前没有活动告警</strong><small>{{ alertResult || '最近一次状态评估正常' }}</small></div></div></article></section>
  </div>
</template>
