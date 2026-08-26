<script setup lang="ts">
import { IconBraces, IconCalendarCheck, IconCheck, IconChecks, IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconCloudDownload, IconCode, IconCopy, IconEdit, IconExternalLink, IconEye, IconEyeOff, IconGripVertical, IconKey, IconPlus, IconRefresh, IconServerBolt, IconSettings, IconTrash, IconWallet, IconX } from '@tabler/icons-vue'
import type { ChannelModelView, ChannelProtocol, ChannelProtocolBindingView, ChannelView, HubKeyView, RelayPlatformType, UserRelayAccountView, UserRelayGroupView } from '#shared/types/hub'

const { data, refresh, status: relayStatus } = useLazyFetch<{ groups: UserRelayGroupView[] }>('/api/console/relay-groups')
const { data: keyData, refresh: refreshKeys } = useLazyFetch<{ keys: HubKeyView[] }>('/api/console/keys')
const toast = useAppToast()
const busy = ref(false)
const discovering = ref(false)
const discoveredModels = ref<string[]>([])
const mappingsExpanded = ref(false)
const testing = ref<string | null>(null)
const testingCandidate = ref<ChannelView | null>(null)
interface RelayTestResult { protocol: ChannelProtocol; endpoint: string; ok: boolean; status: number | null; latencyMs: number; errorCode: string | null; message: string | null; authScheme: 'bearer' | 'x_api_key'; attemptedAuthSchemes: Array<'bearer' | 'x_api_key'>; clientIdentityRejected: boolean; clientIdentityProbed: boolean }
interface RelayConnectivity { endpoint: string; ok: boolean; reachable: boolean; status: number | null; latencyMs: number; errorCode: string | null; message: string | null; modelCount: number; authScheme: 'bearer' | 'x_api_key'; attemptedAuthSchemes: Array<'bearer' | 'x_api_key'> }
const testReport = ref<{ relayName: string; healthy: boolean; summaryStatus: string; connectivity: RelayConnectivity; results: RelayTestResult[] } | null>(null)
const syncing = ref<string | null>(null)
const checkingIn = ref<string | null>(null)
const checkingInAll = ref(false)
const deleting = ref<ChannelView | null>(null)
const editing = ref<ChannelView | null>(null)
const showForm = ref(false)
const configuring = ref<ChannelView | null>(null)
const modelRelay = ref<ChannelView | null>(null)
const configMode = ref<'claude' | 'codex'>('claude')
const configModel = ref('')
const generatedKey = ref('')
const selectedKeyId = ref('new')
const error = ref('')
interface RelayBalance { id: string; name: string; quota: number | null; usedQuota: number | null; remaining: number | null; currency: string | null; fetchedAt: number; error?: string }
const balances = ref<Record<string, RelayBalance>>({})
const balanceLoading = ref<string | null>(null)
const balanceRefreshingAll = ref(false)

const protocolOptions: Array<{ id: ChannelProtocol; label: string; detail: string }> = [
  { id: 'anthropic_messages', label: 'Anthropic Messages', detail: 'Claude Code 原生' },
  { id: 'openai_responses', label: 'OpenAI Responses', detail: 'Codex 原生' },
  { id: 'openai_chat', label: 'OpenAI Chat', detail: '通用兼容 / 转换' }
]
const form = reactive({ name: '', accountLabel: '', groupId: '', groupName: '', homepageUrl: '', platformType: 'generic' as RelayPlatformType, baseUrl: '', apiKey: '', protocols: [binding('anthropic_messages')] as ChannelProtocolBindingView[], models: [] as ChannelModelView[], enabled: true, weight: 1, maxConcurrency: 5, timeoutMs: 120000, checkinEnabled: false, checkinToken: '', checkinUserId: '', insecureHttpAcknowledged: false, clientIdentityMode: 'standard' as 'standard' | 'passthrough' })
const relays = computed<UserRelayAccountView[]>(() => data.value?.groups.flatMap(group => group.accounts) || [])
const checkinCount = computed(() => relays.value.filter(item => item.checkinEnabled && item.checkinConfigured).length || 0)
const activeAccountByGroup = reactive<Record<string, string>>({})
const credentialsLoading = ref(false)
const showApiKey = ref(false)
const showCheckinToken = ref(false)
const originalApiKey = ref('')
const originalCheckinToken = ref('')
const addingToGroup = ref<string | null>(null)
const editingGroup = ref<UserRelayGroupView | null>(null)
const deletingGroup = ref<UserRelayGroupView | null>(null)
const groupError = ref('')
const groupForm = reactive({ name: '', homepageUrl: '', platformType: 'generic' as RelayPlatformType, accountOrderMode: 'manual' as UserRelayGroupView['accountOrderMode'], maxConcurrency: null as number | null, enabled: true })
const duplicating = ref<ChannelView | null>(null)
const duplicateLoading = ref(false)
const duplicateError = ref('')
const duplicateForm = reactive({ newGroup: false, name: '', accountLabel: '', groupName: '', homepageUrl: '', platformType: 'generic' as RelayPlatformType, baseUrl: '', apiKey: '', checkinToken: '', checkinUserId: '', enabled: true })
const showDuplicateApiKey = ref(false)
const showDuplicateCheckinToken = ref(false)
const draggedAccount = ref<{ groupId: string; accountId: string } | null>(null)
const movingAccount = ref<string | null>(null)
const mergeTargetId = ref('')
const activeGroupId = ref('')
const activeGroup = (group: UserRelayGroupView) => group.accounts.find(account => account.id === activeAccountByGroup[group.id]) || group.accounts[0]
const groupFor = (item: ChannelView) => data.value?.groups.find(group => group.id === item.userRelayGroupId) || null
const selectedGroup = computed(() => data.value?.groups.find(group => group.id === activeGroupId.value) || data.value?.groups[0] || null)
const selectedAccount = computed(() => selectedGroup.value ? activeGroup(selectedGroup.value) : undefined)

watch(() => data.value?.groups.map(group => group.id).join('|'), () => {
  if (!data.value?.groups.some(group => group.id === activeGroupId.value)) activeGroupId.value = data.value?.groups[0]?.id || ''
}, { immediate: true })

watch(() => form.platformType, (platform) => {
  if (editing.value) return
  for (const protocol of form.protocols) protocol.authScheme = platform === 'generic' && protocol.protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer'
  if (platform !== 'newapi') form.checkinEnabled = false
})

function binding(protocol: ChannelProtocol): ChannelProtocolBindingView {
  return { protocol, enabled: true, baseUrlOverride: null, authScheme: protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer', apiVersion: protocol === 'anthropic_messages' ? '2023-06-01' : null, probeModel: null, verificationStatus: 'unknown', verifiedAt: null, lastError: null }
}
function emptyModel(): ChannelModelView { return { publicModel: '', upstreamModel: '', enabled: true, endpoints: [] } }
function modelProtocolEnabled(model: ChannelModelView, protocol: ChannelProtocol) {
  return model.protocolBindings?.length
    ? model.protocolBindings.some(binding => binding.protocol === protocol && binding.enabled)
    : Boolean(selectedProtocol(protocol))
}
function toggleModelProtocol(model: ChannelModelView, protocol: ChannelProtocol) {
  const enabledProtocols = form.protocols.map(item => item.protocol)
  const current = model.protocolBindings?.length
    ? model.protocolBindings.map(item => ({ ...item, capabilities: { ...item.capabilities } }))
    : enabledProtocols.map(item => ({ protocol: item, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } }))
  const index = current.findIndex(item => item.protocol === protocol)
  if (index >= 0) current.splice(index, 1)
  else current.push({ protocol, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } })
  model.protocolBindings = current
}
function isDirectModel(model: ChannelModelView) {
  return model.publicModel === model.upstreamModel && !model.endpoints.length && (!model.protocolBindings?.length || model.protocolBindings.every(binding => binding.upstreamModel === model.upstreamModel))
}
function reset() { Object.assign(form, { name: '', accountLabel: '', groupId: '', groupName: '', homepageUrl: '', platformType: 'generic', baseUrl: '', apiKey: '', protocols: [binding('anthropic_messages')], models: [emptyModel()], enabled: true, weight: 1, maxConcurrency: 5, timeoutMs: 120000, checkinEnabled: false, checkinToken: '', checkinUserId: '', insecureHttpAcknowledged: false, clientIdentityMode: 'standard' }); discoveredModels.value = []; mappingsExpanded.value = false; showApiKey.value = false; showCheckinToken.value = false; originalApiKey.value = ''; originalCheckinToken.value = '' }
function create(groupId?: string) { editing.value = null; reset(); addingToGroup.value = groupId || null; const group = groupId ? data.value?.groups.find(item => item.id === groupId) : null; if (group) Object.assign(form, { groupId: group.id, groupName: group.name, homepageUrl: group.homepageUrl || '', platformType: group.platformType }); error.value = ''; showForm.value = true }
async function edit(item: ChannelView) {
  editing.value = item
  addingToGroup.value = null
  const direct = item.models.filter(isDirectModel)
  const mapped = item.models.filter(model => !isDirectModel(model))
  discoveredModels.value = direct.map(model => model.upstreamModel)
  const group = groupFor(item)
  Object.assign(form, { name: item.name, accountLabel: item.accountLabel || item.name, groupId: item.userRelayGroupId || '', groupName: group?.name || '', homepageUrl: group?.homepageUrl || '', platformType: group?.platformType || 'generic', baseUrl: item.baseUrl, apiKey: '', protocols: item.protocols.map(protocol => ({ ...protocol })), models: mapped.length ? mapped.map(model => ({ ...model, endpoints: [...model.endpoints], protocolBindings: model.protocolBindings?.map(protocol => ({ ...protocol, capabilities: { ...protocol.capabilities } })) })) : [emptyModel()], enabled: item.enabled, weight: item.weight, maxConcurrency: item.maxConcurrency, timeoutMs: item.timeoutMs, checkinEnabled: item.checkinEnabled, checkinToken: '', checkinUserId: item.checkinUserId || '', insecureHttpAcknowledged: Boolean(item.insecureHttpAcknowledgedAt), clientIdentityMode: item.clientIdentityMode })
  mappingsExpanded.value = mapped.length > 0
  error.value = ''; credentialsLoading.value = true; showForm.value = true
  try {
    const credentials = await $fetch<{ apiKey: string; checkinToken: string; checkinUserId: string }>(`/api/console/relay-groups/${item.userRelayGroupId}/accounts/${item.id}/credentials`, { method: 'POST' })
    form.apiKey = credentials.apiKey; form.checkinToken = credentials.checkinToken; form.checkinUserId = credentials.checkinUserId || form.checkinUserId; originalApiKey.value = credentials.apiKey; originalCheckinToken.value = credentials.checkinToken
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '读取中转凭据失败' }
  finally { credentialsLoading.value = false }
}
function toggleProtocol(protocol: ChannelProtocol) {
  const index = form.protocols.findIndex(value => value.protocol === protocol)
  if (index >= 0) form.protocols.splice(index, 1)
  else form.protocols.push(binding(protocol))
}
function selectedProtocol(protocol: ChannelProtocol) { return form.protocols.find(item => item.protocol === protocol) }
function setAuthScheme(protocol: ChannelProtocol, value: unknown) {
  const item = selectedProtocol(protocol)
  if (item) item.authScheme = value === 'x_api_key' ? 'x_api_key' : 'bearer'
}
function setProbeModel(protocol: ChannelProtocol, event: Event) {
  const item = selectedProtocol(protocol)
  if (item) item.probeModel = (event.target as HTMLInputElement).value
}
function body() {
  const protocols = form.protocols.map(protocol => ({ ...protocol, id: undefined }))
  const mappedModels: ChannelModelView[] = form.models.filter(model => model.upstreamModel.trim()).map(model => ({
    ...model,
    publicModel: model.publicModel.trim() || model.upstreamModel.trim(),
    upstreamModel: model.upstreamModel.trim(),
    protocolBindings: protocols.flatMap(item => {
      const existing = model.protocolBindings?.find(protocol => protocol.protocol === item.protocol)
      if (model.protocolBindings?.length && !existing) return []
      return [existing || { protocol: item.protocol, upstreamModel: model.upstreamModel.trim(), enabled: true, capabilities: { streaming: true, tools: true } }]
    })
  }))
  const discovered = discoveredModels.value.map(upstreamModel => ({ publicModel: upstreamModel, upstreamModel, enabled: true, endpoints: [], protocolBindings: protocols.map(protocol => ({ protocol: protocol.protocol, upstreamModel, enabled: true, capabilities: { streaming: true, tools: true } })) } satisfies ChannelModelView))
  const models = [...new Map([...discovered, ...mappedModels].map(model => [model.publicModel, model])).values()]
  return {
    name: form.name,
    accountLabel: form.accountLabel,
    baseUrl: form.baseUrl,
    ...(!editing.value || form.apiKey !== originalApiKey.value ? { apiKey: form.apiKey } : {}),
    protocols,
    models,
    enabled: form.enabled,
    weight: form.weight,
    maxConcurrency: form.maxConcurrency,
    timeoutMs: form.timeoutMs,
    checkinEnabled: form.checkinEnabled,
    ...(!editing.value || form.checkinToken !== originalCheckinToken.value ? { checkinToken: form.checkinToken } : {}),
    checkinUserId: form.checkinUserId,
    insecureHttpAcknowledged: form.insecureHttpAcknowledged,
    clientIdentityMode: form.clientIdentityMode,
    ...(editing.value ? {} : { groupId: form.groupId || undefined, groupName: form.groupName, homepageUrl: form.homepageUrl, platformType: form.platformType })
  }
}
function addModel() { form.models.push(emptyModel()) }
function removeModel(index: number) { form.models.splice(index, 1); if (!form.models.length) form.models.push(emptyModel()) }
const probeModels = computed(() => [...new Set([...discoveredModels.value, ...form.models.map(model => model.upstreamModel.trim()).filter(Boolean)])])
async function discoverModels() {
  if (!form.baseUrl || !form.apiKey && !editing.value) { error.value = '请先填写中转地址和 API Key'; return }
  if (!form.protocols.length) { error.value = '请至少选择一种协议'; return }
  discovering.value = true; error.value = ''
  try {
    const result = await $fetch<{ models: string[] }>('/api/console/relays/models/discover', { method: 'POST', body: { relayId: editing.value?.id, baseUrl: form.baseUrl, apiKey: form.apiKey, protocols: form.protocols, timeoutMs: form.timeoutMs } })
    discoveredModels.value = result.models
    for (const protocol of form.protocols) if (!protocol.probeModel && result.models[0]) protocol.probeModel = result.models[0]
    toast.show(`已获取 ${result.models.length} 个模型`, 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '获取模型失败' }
  finally { discovering.value = false }
}
function announceRelayChange() { if (import.meta.client) window.dispatchEvent(new Event('user-relays-changed')) }
async function save() {
  if (!form.protocols.length) { error.value = '请至少选择一种协议'; return }
  if (form.protocols.some(protocol => !protocol.probeModel?.trim())) { error.value = '请为每个协议指定检测模型'; return }
  busy.value = true; error.value = ''
  try {
    const saved = editing.value
      ? await $fetch<ChannelView>(`/api/console/relays/${editing.value.id}`, { method: 'PATCH', body: body() })
      : await $fetch<ChannelView>('/api/console/relays', { method: 'POST', body: body() })
    showForm.value = false; await refresh(); announceRelayChange(); toast.show(editing.value ? '中转已更新' : `中转已添加，已获取 ${saved.models.filter(model => model.enabled).length} 个模型`, 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '保存失败' }
  finally { busy.value = false }
}
async function test(item: ChannelView) {
  testing.value = item.id
  try { const result = await $fetch<{ healthy: boolean; summaryStatus: string; connectivity: RelayConnectivity; results: RelayTestResult[] }>(`/api/console/relays/${item.id}/test`, { method: 'POST' }); testReport.value = { relayName: item.name, ...result }; await refresh(); announceRelayChange(); toast.show(result.summaryStatus === 'all_available' ? '基础连接和协议均检测通过' : result.healthy ? '部分协议检测通过' : '协议检测未通过', result.healthy ? 'success' : 'error') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '检测失败', 'error') }
  finally { testing.value = null }
}
function requestTest(item: ChannelView) {
  if (testing.value) {
    const active = relays.value.find(relay => relay.id === testing.value)
    toast.show(`正在检测“${active?.name || '其他中转'}”，完成后可再次操作`, 'info')
    return
  }
  testingCandidate.value = item
}
async function confirmTest() {
  const item = testingCandidate.value
  if (!item) return
  testingCandidate.value = null
  if (testing.value) {
    toast.show('已有协议检测正在执行，请等待完成', 'info')
    return
  }
  await test(item)
}
async function sync(item: ChannelView) {
  syncing.value = item.id
  try { const result = await $fetch<{ discovered: number; added: number; removed: number; reactivated: number }>(`/api/console/relays/${item.id}/models/sync`, { method: 'POST' }); await refresh(); toast.show(`同步 ${result.discovered} 个模型：新增 ${result.added}，移除 ${result.removed}，恢复 ${result.reactivated}`, 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '同步失败', 'error') }
  finally { syncing.value = null }
}
async function checkin(item: ChannelView) {
  checkingIn.value = item.id
  try {
    const result = await $fetch<{ success: boolean; status: string; message: string; awardedQuota: number | null }>(`/api/console/relays/${item.id}/checkin`, { method: 'POST' })
    await refresh()
    toast.show(result.awardedQuota ? `${result.message}，获得 ${result.awardedQuota} 额度` : result.message, result.success ? 'success' : 'error')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '签到失败', 'error')
  } finally { checkingIn.value = null }
}
async function checkinAll() {
  checkingInAll.value = true
  try {
    const result = await $fetch<{ summary: { total: number; success: number; failed: number } }>('/api/console/relays/checkin-all', { method: 'POST' })
    await refresh()
    toast.show(`签到完成：${result.summary.success}/${result.summary.total} 成功`, result.summary.failed ? 'error' : 'success')
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '一键签到失败', 'error')
  } finally { checkingInAll.value = false }
}
async function remove() {
  if (!deleting.value) return
  busy.value = true
  try { await $fetch(`/api/console/relays/${deleting.value.id}`, { method: 'DELETE' }); deleting.value = null; await Promise.all([refresh(), refreshKeys()]); announceRelayChange(); toast.show('中转已删除', 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '删除失败', 'error') }
  finally { busy.value = false }
}
function openConfig(item: ChannelView) { configuring.value = item; configModel.value = item.models.find(model => model.enabled)?.publicModel || ''; configMode.value = item.protocols.some(protocol => protocol.protocol === 'anthropic_messages' || protocol.protocol === 'openai_chat') ? 'claude' : 'codex'; selectedKeyId.value = keyData.value?.keys.find(key => key.routeMode === 'private_only' && (!key.channelIds.length || key.channelIds.includes(item.id)))?.id || 'new'; generatedKey.value = ''; error.value = '' }
function openModels(item: ChannelView) { modelRelay.value = item }
async function createDedicatedKey() {
  if (!configuring.value || !configModel.value) { error.value = '请先选择模型'; return }
  busy.value = true; error.value = ''
  try {
    const result = await $fetch<{ key: string }>('/api/console/keys', { method: 'POST', body: { name: `${configuring.value.name} · ${configMode.value === 'claude' ? 'Claude Code' : 'Codex'}`, note: '由中转配置生成器创建', routeMode: 'private_only', channelIds: [] } })
    generatedKey.value = result.key; await refreshKeys()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '创建专用 Key 失败' }
  finally { busy.value = false }
}
async function useExistingKey() {
  if (!configuring.value || selectedKeyId.value === 'new') return createDedicatedKey()
  busy.value = true; error.value = ''
  try {
    await $fetch(`/api/console/keys/${selectedKeyId.value}/channels`, { method: 'PUT', body: { routeMode: 'private_only', channelIds: [] } })
    generatedKey.value = (await $fetch<{ key: string }>(`/api/console/keys/${selectedKeyId.value}/reveal`, { method: 'POST' })).key
    await refreshKeys()
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '绑定或读取 Key 失败' }
  finally { busy.value = false }
}
const configText = computed(() => {
  if (!configuring.value || !configModel.value) return ''
  const key = generatedKey.value || 'YOUR_HUB_KEY'
  if (configMode.value === 'claude') return JSON.stringify({ env: { ANTHROPIC_BASE_URL: location.origin, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: configModel.value } }, null, 2)
  const wireApi = configuring.value.protocols.some(protocol => protocol.protocol === 'openai_responses') ? 'responses' : 'chat'
  return `model_provider = "Zephyr"\nmodel = "${configModel.value}"\n\n[model_providers.Zephyr]\nname = "Zephyr Hub"\nbase_url = "${location.origin}/v1"\nwire_api = "${wireApi}"\nrequires_openai_auth = false\nenv_key = "ZEPHYR_HUB_KEY"\n\n# ZEPHYR_HUB_KEY=${key}`
})
async function copyConfig() { await navigator.clipboard.writeText(configText.value); toast.show('配置已复制', 'success') }
const protocolLabel = (protocol: ChannelProtocol) => ({ anthropic_messages: 'Messages', openai_responses: 'Responses', openai_chat: 'Chat' })[protocol]
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value) : '未检测'
const checkedInToday = (item: ChannelView) => Boolean(item.lastCheckinAt && ['success', 'already'].includes(item.lastCheckinStatus || '') && new Date(item.lastCheckinAt).toDateString() === new Date().toDateString())
const formatBalance = (value: number | null, currency: string | null) => value === null ? '未知' : `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''}${value.toFixed(2)}`
const balanceValue = (id: string) => balances.value[id] || { quota: null, usedQuota: null, remaining: null, currency: null, fetchedAt: 0 }
async function refreshBalance(item: ChannelView) {
  balanceLoading.value = item.id
  try { balances.value[item.id] = await $fetch<RelayBalance>(`/api/console/relays/${item.id}/balance`, { method: 'POST' }) }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; balances.value[item.id] = { id: item.id, name: item.name, quota: null, usedQuota: null, remaining: null, currency: null, fetchedAt: Date.now(), error: failure.data?.message || failure.message || '余额查询失败' } }
  finally { balanceLoading.value = null }
}
async function refreshUserRelayGroupBalances(groupId: string) {
  balanceRefreshingAll.value = true
  try { await $fetch(`/api/console/relay-groups/${groupId}/balances`, { method: 'POST' }); await refresh(); toast.show('站点账号余额已刷新', 'success') }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '刷新余额失败', 'error') }
  finally { balanceRefreshingAll.value = false }
}
async function setGroupOrder(group: UserRelayGroupView, value: unknown) {
  try { await $fetch(`/api/console/relay-groups/${group.id}`, { method: 'PATCH', body: { accountOrderMode: value } }); await refresh() }
  catch (failure) { const value = failure as { data?: { message?: string }; message?: string }; toast.show(value.data?.message || value.message || '保存账号排序失败', 'error') }
}
async function setGroupPlatform(group: UserRelayGroupView, value: unknown) {
  if (value === group.platformType) return
  try { await $fetch(`/api/console/relay-groups/${group.id}`, { method: 'PATCH', body: { platformType: value } }); await refresh(); toast.show('站点平台已更新', 'success') }
  catch (failure) { const value = failure as { data?: { message?: string }; message?: string }; toast.show(value.data?.message || value.message || '保存站点平台失败', 'error') }
}
function openGroupSettings(group: UserRelayGroupView) {
  editingGroup.value = group
  Object.assign(groupForm, { name: group.name, homepageUrl: group.homepageUrl || '', platformType: group.platformType, accountOrderMode: group.accountOrderMode, maxConcurrency: group.maxConcurrency, enabled: group.enabled })
  groupError.value = ''
  mergeTargetId.value = ''
}
async function saveGroup() {
  if (!editingGroup.value) return
  busy.value = true; groupError.value = ''
  try {
    await $fetch(`/api/console/relay-groups/${editingGroup.value.id}`, { method: 'PATCH', body: { ...groupForm } })
    editingGroup.value = null; await refresh(); announceRelayChange(); toast.show('站点设置已保存', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; groupError.value = failure.data?.message || failure.message || '保存站点设置失败' }
  finally { busy.value = false }
}
async function removeGroup() {
  if (!deletingGroup.value) return
  busy.value = true
  try {
    await $fetch(`/api/console/relay-groups/${deletingGroup.value.id}`, { method: 'DELETE', body: { deleteAccounts: true } })
    deletingGroup.value = null; await Promise.all([refresh(), refreshKeys()]); announceRelayChange(); toast.show('站点及其账号已删除', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '删除站点失败', 'error') }
  finally { busy.value = false }
}
async function moveAccountToGroup(account: UserRelayAccountView, targetGroupId: unknown) {
  if (!editingGroup.value || typeof targetGroupId !== 'string' || !targetGroupId) return
  movingAccount.value = account.id; groupError.value = ''
  try {
    await $fetch(`/api/console/relay-groups/${editingGroup.value.id}/accounts/${account.id}/move`, { method: 'POST', body: { targetGroupId } })
    editingGroup.value = null; await refresh(); announceRelayChange(); toast.show('账号已移动到目标站点', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; groupError.value = failure.data?.message || failure.message || '移动账号失败' }
  finally { movingAccount.value = null }
}
async function mergeGroup() {
  if (!editingGroup.value || !mergeTargetId.value) return
  busy.value = true; groupError.value = ''
  try {
    await $fetch('/api/console/relay-groups/merge', { method: 'POST', body: { targetGroupId: mergeTargetId.value, sourceGroupIds: [editingGroup.value.id] } })
    editingGroup.value = null; await refresh(); announceRelayChange(); toast.show('站点账号已合并', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; groupError.value = failure.data?.message || failure.message || '合并站点失败' }
  finally { busy.value = false }
}
async function moveAccount(group: UserRelayGroupView, accountId: string, offset: number) {
  const ids = group.accounts.map(account => account.id)
  const index = ids.indexOf(accountId)
  const target = index + offset
  if (index < 0 || target < 0 || target >= ids.length) return
  const [moved] = ids.splice(index, 1)
  if (!moved) return
  ids.splice(target, 0, moved)
  try { await $fetch(`/api/console/relay-groups/${group.id}/account-order`, { method: 'PUT', body: { orderedIds: ids } }); await refresh() }
  catch (failure) { const value = failure as { data?: { message?: string }; message?: string }; toast.show(value.data?.message || value.message || '保存账号顺序失败', 'error') }
}
function startAccountDrag(groupId: string, accountId: string, event: DragEvent) {
  draggedAccount.value = { groupId, accountId }
  event.dataTransfer?.setData('text/plain', accountId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
async function dropAccount(group: UserRelayGroupView, targetId: string) {
  const dragged = draggedAccount.value
  draggedAccount.value = null
  if (!dragged || dragged.groupId !== group.id || dragged.accountId === targetId) return
  const ids = group.accounts.map(account => account.id)
  const from = ids.indexOf(dragged.accountId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0) return
  const [moved] = ids.splice(from, 1)
  if (!moved) return
  ids.splice(to, 0, moved)
  try { await $fetch(`/api/console/relay-groups/${group.id}/account-order`, { method: 'PUT', body: { orderedIds: ids } }); await refresh() }
  catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '保存账号顺序失败', 'error') }
}
async function openDuplicate(item: ChannelView) {
  duplicating.value = item; duplicateLoading.value = true; duplicateError.value = ''; showDuplicateApiKey.value = false; showDuplicateCheckinToken.value = false
  const group = groupFor(item)
  Object.assign(duplicateForm, { newGroup: false, name: `${item.name} - 副本`, accountLabel: `${item.accountLabel || item.name} - 副本`, groupName: `${group?.name || item.name} - 副本`, homepageUrl: group?.homepageUrl || item.baseUrl, platformType: group?.platformType || 'generic', baseUrl: item.baseUrl, apiKey: '', checkinToken: '', checkinUserId: item.checkinUserId || '', enabled: true })
  try {
    const credentials = await $fetch<{ apiKey: string; checkinToken: string; checkinUserId: string }>(`/api/console/relay-groups/${item.userRelayGroupId}/accounts/${item.id}/credentials`, { method: 'POST' })
    duplicateForm.apiKey = credentials.apiKey; duplicateForm.checkinToken = credentials.checkinToken; duplicateForm.checkinUserId = credentials.checkinUserId || duplicateForm.checkinUserId
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; duplicateError.value = failure.data?.message || failure.message || '读取中转凭据失败' }
  finally { duplicateLoading.value = false }
}
async function duplicateRelay() {
  const item = duplicating.value
  if (!item) return
  busy.value = true; duplicateError.value = ''
  try {
    await $fetch(`/api/console/relay-groups/${item.userRelayGroupId}/accounts/${item.id}/duplicate`, { method: 'POST', body: { ...duplicateForm } })
    duplicating.value = null; await refresh(); announceRelayChange(); toast.show(duplicateForm.newGroup ? '已复制为新站点' : '已添加副本账号', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; duplicateError.value = failure.data?.message || failure.message || '复制中转失败' }
  finally { busy.value = false }
}
async function refreshBalances() {
  if (!relays.value.length) return
  balanceRefreshingAll.value = true
  try { await $fetch('/api/console/relay-groups/balances', { method: 'POST' }); await refresh() } finally { balanceRefreshingAll.value = false }
}
function groupCapabilitySummary(group: UserRelayGroupView) {
  const active = group.accounts.filter(account => account.state.routingState === 'active' && account.enabled)
  const count = (protocol: ChannelProtocol) => active.filter(account => account.protocols.some(item => item.protocol === protocol && item.enabled && item.verificationStatus !== 'failed')).length
  return `Claude ${count('anthropic_messages')}/${group.accounts.length} · Codex ${count('openai_responses')}/${group.accounts.length} · Chat ${count('openai_chat')}/${group.accounts.length}`
}
function groupModelCount(group: UserRelayGroupView) { return new Set(group.accounts.flatMap(account => account.models.filter(model => model.enabled).map(model => model.publicModel))).size }
function groupBalanceSummary(group: UserRelayGroupView) {
  const balances = group.accounts.flatMap(account => account.state.remainingBalance === null || !account.state.currency ? [] : [{ amount: account.state.remainingBalance, currency: account.state.currency }])
  if (!balances.length) return '余额待查'
  const totals = new Map<string, number>()
  for (const item of balances) totals.set(item.currency, (totals.get(item.currency) || 0) + item.amount)
  return [...totals].map(([currency, amount]) => formatBalance(amount, currency)).join(' · ')
}
</script>

<template>
  <div class="admin-page relay-page">
    <header class="resource-panel-header"><div><span class="admin-kicker">PRIVATE RELAY GROUPS</span><h2>我的中转</h2><p>站点作为故障转移节点，账号在站点内按 Tab 收敛。</p></div><div class="resource-panel-actions"><button class="button button--quiet button--small" :disabled="balanceRefreshingAll" @click="refreshBalances"><IconWallet :size="15" />{{ balanceRefreshingAll ? '查询中' : '刷新余额' }}</button><button class="button button--secondary" :disabled="!checkinCount || checkingInAll" @click="checkinAll"><IconChecks :size="17" />{{ checkingInAll ? '签到中' : '一键签到' }}</button><button class="button button--primary" @click="create()"><IconPlus :size="17" />添加站点</button></div></header>
    <nav v-if="data?.groups.length" class="relay-site-tabs" aria-label="中转站点">
      <button v-for="group in data.groups" :key="group.id" type="button" :class="{ active: selectedGroup?.id === group.id }" @click="activeGroupId = group.id">
        <strong>{{ group.name }}</strong>
        <small>{{ group.accounts.filter(account => account.state.routingState === 'active').length }}/{{ group.accounts.length }} 可用 · {{ groupModelCount(group) }} 模型</small>
      </button>
    </nav>
    <section v-if="selectedGroup" class="relay-group-tabs">
      <article class="relay-group-summary">
        <header><div><strong><a v-if="selectedGroup.homepageUrl" :href="selectedGroup.homepageUrl" target="_blank" rel="noopener noreferrer">{{ selectedGroup.name }}<IconExternalLink :size="12" /></a><template v-else>{{ selectedGroup.name }}</template></strong><small>{{ selectedGroup.platformType === 'newapi' ? 'NewAPI' : selectedGroup.platformType === 'sub2api' ? 'Sub2API' : '通用兼容站' }} · {{ selectedGroup.accounts.filter(account => account.state.routingState === 'active').length }}/{{ selectedGroup.accounts.length }} 可用 · {{ groupModelCount(selectedGroup) }} 模型 · {{ groupBalanceSummary(selectedGroup) }}</small><small>{{ groupCapabilitySummary(selectedGroup) }}</small></div><div class="relay-group-actions"><AppSelect :model-value="selectedGroup.accountOrderMode" aria-label="账号排序" @update:model-value="setGroupOrder(selectedGroup, $event)"><option value="manual">手工顺序</option><option value="balance_desc">余额降序</option><option value="balance_asc">余额升序</option></AppSelect><button class="icon-button" title="添加账号" aria-label="添加账号" @click="create(selectedGroup.id)"><IconPlus :size="15" /></button><button class="icon-button" title="刷新站点余额" aria-label="刷新站点余额" :disabled="balanceRefreshingAll || selectedGroup.platformType === 'generic'" @click="refreshUserRelayGroupBalances(selectedGroup.id)"><IconWallet :size="15" /></button><button class="icon-button" title="站点设置" aria-label="站点设置" @click="openGroupSettings(selectedGroup)"><IconSettings :size="15" /></button></div></header>
        <nav v-if="selectedGroup.accounts.length > 1" class="relay-account-tabs" aria-label="站点账号"><div v-for="(account, index) in selectedGroup.accounts" :key="account.id" class="relay-account-tab" :class="{ active: (activeAccountByGroup[selectedGroup.id] || selectedGroup.accounts[0]?.id) === account.id, dragging: draggedAccount?.accountId === account.id }" :draggable="selectedGroup.accountOrderMode === 'manual'" @dragstart="startAccountDrag(selectedGroup.id, account.id, $event)" @dragend="draggedAccount = null" @dragover.prevent @drop.prevent="dropAccount(selectedGroup, account.id)"><IconGripVertical v-if="selectedGroup.accountOrderMode === 'manual'" class="relay-drag-handle" :size="14" /><button type="button" @click="activeAccountByGroup[selectedGroup.id] = account.id"><span>{{ account.accountLabel || account.name }}</span><small>{{ account.state.routingState === 'depleted' ? '额度耗尽，等待刷新' : account.state.routingState === 'credential_error' ? '凭据失效' : account.state.remainingBalance === null ? '余额待查' : formatBalance(account.state.remainingBalance, account.state.currency) }}</small></button><span v-if="selectedGroup.accountOrderMode === 'manual'" class="relay-tab-order"><button type="button" title="前移" aria-label="账号前移" :disabled="index === 0" @click="moveAccount(selectedGroup, account.id, -1)"><IconChevronLeft :size="13" /></button><button type="button" title="后移" aria-label="账号后移" :disabled="index === selectedGroup.accounts.length - 1" @click="moveAccount(selectedGroup, account.id, 1)"><IconChevronRight :size="13" /></button></span></div></nav>
        <article v-if="selectedAccount" class="relay-row">
          <div class="relay-identity"><span><IconServerBolt :size="19" /></span><div><strong>{{ selectedAccount.name }}</strong><a class="relay-url" :href="selectedAccount.baseUrl" target="_blank" rel="noopener noreferrer" :title="`打开 ${selectedAccount.baseUrl}`"><IconExternalLink :size="12" />{{ selectedAccount.baseUrl }}</a><small>仅自己 · {{ selectedAccount.models.filter(model => model.enabled).length }} 个模型</small></div></div>
          <div class="relay-protocols"><span v-for="protocol in selectedAccount.protocols" :key="protocol.id || protocol.protocol" :data-status="protocol.verificationStatus"><i />{{ protocolLabel(protocol.protocol) }}</span></div>
          <div class="relay-health"><strong>{{ selectedAccount.healthStatus === 'healthy' ? '可用' : selectedAccount.healthStatus === 'unhealthy' ? '需处理' : '待检测' }}</strong><small>{{ date(selectedAccount.lastHealthCheckAt) }}</small><em v-if="selectedAccount.lastHealthError" :title="selectedAccount.lastHealthError || undefined">{{ selectedAccount.lastHealthError }}</em></div>
          <div class="relay-balance"><template v-if="selectedAccount.state.balanceError"><strong>查询失败</strong><small :title="selectedAccount.state.balanceError || undefined">{{ selectedAccount.state.balanceError }}</small></template><template v-else-if="selectedAccount.state.balanceStatus === 'success'"><strong>{{ formatBalance(selectedAccount.state.remainingBalance, selectedAccount.state.currency) }}</strong><small>购买 {{ formatBalance(selectedAccount.state.purchasedQuota, selectedAccount.state.currency) }} · 赠送 {{ formatBalance(selectedAccount.state.giftQuota, selectedAccount.state.currency) }}</small></template><template v-else><strong>余额待查</strong><small>{{ selectedGroup.platformType === 'generic' ? '通用站未配置余额接口' : '点击刷新余额' }}</small></template></div>
          <div class="table-actions"><button class="button button--quiet button--small relay-model-button" :disabled="!selectedAccount.models.length" @click="openModels(selectedAccount)"><IconBraces :size="14" />查看模型 <span>{{ selectedAccount.models.filter(model => model.enabled).length }}</span></button><button class="icon-button" title="刷新余额" :aria-label="`${selectedAccount.name} 刷新余额`" :disabled="balanceLoading === selectedAccount.id || selectedGroup.platformType === 'generic' || (selectedGroup.platformType === 'newapi' && !selectedAccount.checkinConfigured)" @click="refreshBalance(selectedAccount)"><IconWallet :size="16" /></button><button v-if="selectedAccount.checkinEnabled && selectedAccount.checkinConfigured" class="icon-button" :class="{ 'is-complete': checkedInToday(selectedAccount) }" :title="checkedInToday(selectedAccount) ? '今日已签到' : '签到'" :aria-label="`${selectedAccount.name} ${checkedInToday(selectedAccount) ? '今日已签到' : '签到'}`" :disabled="checkingIn === selectedAccount.id || checkedInToday(selectedAccount)" @click="checkin(selectedAccount)"><IconCalendarCheck :size="17" /></button><button class="icon-button" :title="testing === selectedAccount.id ? '协议检测正在执行' : '协议检测'" :aria-label="testing === selectedAccount.id ? `${selectedAccount.name} 协议检测正在执行` : `${selectedAccount.name} 协议检测`" :aria-busy="testing === selectedAccount.id" @click="requestTest(selectedAccount)"><IconRefresh :class="{ 'is-spinning': testing === selectedAccount.id }" :size="17" /></button><button class="icon-button" title="同步模型" aria-label="同步模型" :disabled="syncing === selectedAccount.id" @click="sync(selectedAccount)"><IconCloudDownload :size="17" /></button><button class="icon-button" title="复制中转" aria-label="复制中转" @click="openDuplicate(selectedAccount)"><IconCopy :size="17" /></button><button class="icon-button" title="生成客户端配置" aria-label="生成客户端配置" @click="openConfig(selectedAccount)"><IconCode :size="17" /></button><button class="icon-button" title="编辑" aria-label="编辑中转" @click="edit(selectedAccount)"><IconEdit :size="17" /></button><button class="icon-button danger" title="删除" aria-label="删除中转" @click="deleting = selectedAccount"><IconTrash :size="17" /></button></div>
        </article>
      </article>
    </section>
    <div v-if="relayStatus === 'pending' && !data" class="admin-empty relay-empty"><IconRefresh class="is-spinning" :size="24" /><strong>正在加载中转站点</strong></div>
    <div v-else-if="!data?.groups.length" class="admin-empty relay-empty"><IconServerBolt :size="26" /><strong>还没有私有中转</strong><p>添加一个支持 Messages、Responses 或 Chat 的站点。</p><button class="button button--primary button--small" @click="create()">添加第一个站点</button></div>

    <AppDrawer :open="showForm" kicker="PRIVATE RELAY" :title="editing ? '编辑中转' : '添加中转'" @close="showForm = false"><form class="admin-form" @submit.prevent="save">
      <div v-if="!editing" class="form-grid"><label><span>站点名称 *</span><input v-model="form.groupName" :disabled="Boolean(form.groupId)" required placeholder="例如：AgentRouter"></label><label><span>平台 *</span><AppSelect v-model="form.platformType" :disabled="Boolean(form.groupId)"><option value="generic">通用兼容站</option><option value="newapi">NewAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
      <div class="form-grid"><label><span>账号名称 *</span><input v-model="form.name" required placeholder="例如：主账号"></label><label><span>账号标签</span><input v-model="form.accountLabel" placeholder="用于账号 Tab 和日志"></label></div>
      <label><span>Base URL *</span><input v-model="form.baseUrl" type="url" required placeholder="https://relay.example.com 或 http://relay.example.com"></label>
      <label v-if="form.baseUrl.startsWith('http://')" class="relay-http-warning"><input v-model="form.insecureHttpAcknowledged" type="checkbox"><span>我确认该站点使用明文 HTTP，API Key、请求和响应可能被读取或篡改。</span></label>
      <label><span>上游 API Key *</span><span class="relay-key-input"><span class="relay-secret-input"><input v-model="form.apiKey" :type="showApiKey ? 'text' : 'password'" required autocomplete="off"><button class="icon-button" type="button" :title="showApiKey ? '隐藏 API Key' : '显示 API Key'" @click="showApiKey = !showApiKey"><IconEyeOff v-if="showApiKey" :size="16" /><IconEye v-else :size="16" /></button></span><button type="button" class="button button--secondary button--small" :disabled="discovering || !form.baseUrl || !form.apiKey" @click="discoverModels"><IconCloudDownload :size="15" />{{ discovering ? '获取中' : '获取模型' }}</button></span></label>
      <section v-if="form.platformType === 'newapi'" class="form-section relay-checkin"><header><div><h3>NewAPI 控制台</h3><span>余额与签到</span></div><label class="switch"><input v-model="form.checkinEnabled" type="checkbox"><span />启用签到</label></header><div class="form-grid"><label><span>控制台访问令牌 *</span><span class="relay-secret-input"><input v-model="form.checkinToken" :type="showCheckinToken ? 'text' : 'password'" required autocomplete="off" placeholder="NewAPI access token"><button class="icon-button" type="button" :title="showCheckinToken ? '隐藏令牌' : '显示令牌'" @click="showCheckinToken = !showCheckinToken"><IconEyeOff v-if="showCheckinToken" :size="16" /><IconEye v-else :size="16" /></button></span></label><label><span>用户 ID（可选）</span><input v-model="form.checkinUserId" autocomplete="off" placeholder="用于 New-Api-User"></label></div></section>
      <section class="form-section"><header><div><h3>上游协议</h3><span>每个协议使用指定模型检测，认证失败时自动补测另一种认证</span></div></header><datalist id="relay-discovered-models"><option v-for="model in probeModels" :key="model" :value="model" /></datalist><div class="protocol-picker"><div v-for="option in protocolOptions" :key="option.id" class="protocol-option" :class="{ active: selectedProtocol(option.id) }"><button type="button" @click="toggleProtocol(option.id)"><IconCheck :size="15" /><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button><div v-if="selectedProtocol(option.id)" class="protocol-option__settings"><label><span>默认认证</span><AppSelect :model-value="selectedProtocol(option.id)?.authScheme" @update:model-value="setAuthScheme(option.id, $event)"><option value="bearer">Bearer</option><option value="x_api_key">x-api-key</option></AppSelect></label><label><span>检测模型 *</span><input :value="selectedProtocol(option.id)?.probeModel || ''" list="relay-discovered-models" required placeholder="选择或输入模型" @input="setProbeModel(option.id, $event)"></label></div></div></div></section>
      <section class="form-section relay-compat-settings"><header><div><h3>兼容设置</h3><span>模型只在你点击获取或同步时更新</span></div></header><label class="switch"><input v-model="form.clientIdentityMode" type="checkbox" true-value="passthrough" false-value="standard"><span />透传真实 Claude Code / Codex 客户端身份</label></section>
      <section v-if="discoveredModels.length" class="form-section relay-discovered"><header><div><h3>已获取模型</h3><span>{{ discoveredModels.length }} 个模型将直接启用</span></div><button type="button" class="button button--quiet button--small" @click="discoveredModels = []">清空</button></header><div class="relay-model-badges"><span v-for="model in discoveredModels" :key="model" :title="model">{{ model }}</span></div></section>
      <section class="form-section relay-mappings"><header><button type="button" class="relay-section-toggle" :aria-expanded="mappingsExpanded" @click="mappingsExpanded = !mappingsExpanded"><component :is="mappingsExpanded ? IconChevronUp : IconChevronDown" :size="16" /><span><strong>模型映射</strong><small>仅在需要修改 Hub 对外模型名或协议绑定时配置</small></span></button><button v-if="mappingsExpanded" type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" />添加映射</button></header><div v-if="mappingsExpanded" class="relay-model-list"><div v-for="(model, index) in form.models" :key="model.id || index" class="relay-model-entry"><div class="relay-model-row"><input v-model="model.publicModel" placeholder="Hub 模型名（留空自动同名）"><span>→</span><input v-model="model.upstreamModel" placeholder="上游模型名"><button type="button" class="icon-button danger" title="移除模型" aria-label="移除模型" @click="removeModel(index)"><IconX :size="15" /></button></div><div class="relay-model-protocols"><button v-for="protocol in form.protocols" :key="protocol.protocol" type="button" :class="{ active: modelProtocolEnabled(model, protocol.protocol) }" @click="toggleModelProtocol(model, protocol.protocol)"><IconCheck :size="12" />{{ protocolLabel(protocol.protocol) }}</button></div></div></div></section>
      <div class="form-grid relay-settings-grid"><label><span>权重</span><input v-model.number="form.weight" type="number" min="1"></label><label><span>最大并发</span><input v-model.number="form.maxConcurrency" type="number" min="1"></label><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="1000"></label></div>
      <p v-if="error" class="form-error">{{ error }}</p><footer><label class="switch"><input v-model="form.enabled" type="checkbox"><span />启用中转</label><div><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '保存中' : '保存中转' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer v-if="editingGroup" :open="Boolean(editingGroup)" kicker="RELAY GROUP" :title="`设置 ${editingGroup.name}`" @close="editingGroup = null"><form class="admin-form" @submit.prevent="saveGroup">
      <div class="form-grid"><label><span>站点名称 *</span><input v-model="groupForm.name" required></label><label><span>平台 *</span><AppSelect v-model="groupForm.platformType"><option value="generic">通用兼容站</option><option value="newapi">NewAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
      <label><span>站点官网</span><input v-model="groupForm.homepageUrl" type="url" placeholder="https://relay.example.com"></label>
      <div class="form-grid"><label><span>账号排序</span><AppSelect v-model="groupForm.accountOrderMode"><option value="manual">手工顺序</option><option value="balance_desc">余额从高到低</option><option value="balance_asc">余额从低到高</option></AppSelect></label><label><span>站点总并发</span><input v-model.number="groupForm.maxConcurrency" type="number" min="1" placeholder="不限制"></label></div>
      <section v-if="(data?.groups.length || 0) > 1" class="form-section relay-group-move"><header><div><h3>账号归组</h3><span>单独移动账号，或把当前站点整体合并到其他站点</span></div></header><div v-for="account in editingGroup.accounts" :key="account.id"><span><strong>{{ account.accountLabel || account.name }}</strong><small>{{ account.baseUrl }}</small></span><AppSelect :model-value="''" :disabled="movingAccount === account.id" aria-label="移动账号到其他站点" @update:model-value="moveAccountToGroup(account, $event)"><option value="">移动到…</option><option v-for="target in data?.groups.filter(group => group.id !== editingGroup?.id) || []" :key="target.id" :value="target.id">{{ target.name }}</option></AppSelect></div><footer><AppSelect v-model="mergeTargetId" aria-label="合并目标站点"><option value="">选择合并目标…</option><option v-for="target in data?.groups.filter(group => group.id !== editingGroup?.id) || []" :key="target.id" :value="target.id">{{ target.name }}</option></AppSelect><button type="button" class="button button--secondary button--small" :disabled="!mergeTargetId || busy" @click="mergeGroup">合并当前站点</button></footer></section>
      <p v-if="groupError" class="form-error">{{ groupError }}</p><footer><button type="button" class="button button--danger" @click="deletingGroup = editingGroup; editingGroup = null"><IconTrash :size="15" />删除站点</button><div><label class="switch"><input v-model="groupForm.enabled" type="checkbox"><span />启用站点</label><button type="button" class="button button--secondary" @click="editingGroup = null">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '保存中' : '保存设置' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer v-if="duplicating" :open="Boolean(duplicating)" kicker="DUPLICATE RELAY" :title="`复制 ${duplicating.name}`" @close="duplicating = null; duplicateForm.apiKey = ''; duplicateForm.checkinToken = ''"><form class="admin-form" @submit.prevent="duplicateRelay">
      <div class="relay-copy-target" role="radiogroup" aria-label="复制目标"><label :class="{ active: !duplicateForm.newGroup }"><input v-model="duplicateForm.newGroup" type="radio" :value="false"><span><strong>当前站点的新账号</strong><small>保留在同一个故障转移节点内</small></span></label><label :class="{ active: duplicateForm.newGroup }"><input v-model="duplicateForm.newGroup" type="radio" :value="true"><span><strong>新的站点组</strong><small>创建独立的故障转移节点</small></span></label></div>
      <div v-if="duplicateForm.newGroup" class="form-grid"><label><span>新站点名称 *</span><input v-model="duplicateForm.groupName" required></label><label><span>平台 *</span><AppSelect v-model="duplicateForm.platformType"><option value="generic">通用兼容站</option><option value="newapi">NewAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
      <label v-if="duplicateForm.newGroup"><span>站点官网</span><input v-model="duplicateForm.homepageUrl" type="url"></label>
      <div class="form-grid"><label><span>账号名称 *</span><input v-model="duplicateForm.name" required></label><label><span>账号标签</span><input v-model="duplicateForm.accountLabel"></label></div>
      <label><span>Base URL *</span><input v-model="duplicateForm.baseUrl" type="url" required></label>
      <label><span>上游 API Key *</span><span class="relay-secret-input"><input v-model="duplicateForm.apiKey" :type="showDuplicateApiKey ? 'text' : 'password'" required autocomplete="off"><button class="icon-button" type="button" :title="showDuplicateApiKey ? '隐藏 API Key' : '显示 API Key'" :aria-label="showDuplicateApiKey ? '隐藏 API Key' : '显示 API Key'" @click="showDuplicateApiKey = !showDuplicateApiKey"><IconEyeOff v-if="showDuplicateApiKey" :size="16" /><IconEye v-else :size="16" /></button></span></label>
      <template v-if="duplicateForm.platformType === 'newapi'"><label><span>控制台访问令牌 *</span><span class="relay-secret-input"><input v-model="duplicateForm.checkinToken" :type="showDuplicateCheckinToken ? 'text' : 'password'" required autocomplete="off"><button class="icon-button" type="button" :title="showDuplicateCheckinToken ? '隐藏令牌' : '显示令牌'" :aria-label="showDuplicateCheckinToken ? '隐藏令牌' : '显示令牌'" @click="showDuplicateCheckinToken = !showDuplicateCheckinToken"><IconEyeOff v-if="showDuplicateCheckinToken" :size="16" /><IconEye v-else :size="16" /></button></span></label><label><span>用户 ID</span><input v-model="duplicateForm.checkinUserId"></label></template>
      <p v-if="duplicateLoading" class="form-note">正在读取原账号凭据…</p><p v-if="duplicateError" class="form-error">{{ duplicateError }}</p><footer><label class="switch"><input v-model="duplicateForm.enabled" type="checkbox"><span />启用副本</label><div><button type="button" class="button button--secondary" @click="duplicating = null">取消</button><button class="button button--primary" :disabled="busy || duplicateLoading">{{ busy ? '复制中' : '确认复制' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer v-if="configuring" :open="Boolean(configuring)" kicker="CLIENT SETUP" :title="`连接 ${configuring.name}`" @close="configuring = null"><div class="config-builder">
      <div class="config-tabs"><button :class="{ active: configMode === 'claude' }" :disabled="!configuring.protocols.some(item => item.protocol === 'anthropic_messages' || item.protocol === 'openai_chat')" @click="configMode = 'claude'">Claude Code</button><button :class="{ active: configMode === 'codex' }" :disabled="!configuring.protocols.some(item => item.protocol === 'openai_responses' || item.protocol === 'openai_chat')" @click="configMode = 'codex'">Codex</button></div>
      <label><span>模型</span><AppSelect v-model="configModel"><option v-for="model in configuring.models.filter(item => item.enabled)" :key="model.id || model.publicModel" :value="model.publicModel">{{ model.publicModel }}</option></AppSelect></label>
      <div class="key-choice"><label><span>Hub Key</span><AppSelect v-model="selectedKeyId"><option value="new">新建专用 Key</option><option v-for="key in keyData?.keys.filter(item => item.status === 'active') || []" :key="key.id" :value="key.id">{{ key.name }} · {{ key.maskedKey }}</option></AppSelect></label></div>
      <div class="key-provision"><div><IconKey :size="18" /><span><strong>专用 Hub Key</strong><small>按故障转移顺序使用所有支持该模型的私有中转。</small></span></div><button class="button button--secondary button--small" :disabled="busy || !configModel" @click="useExistingKey">{{ generatedKey ? '重新绑定' : selectedKeyId === 'new' ? '生成专用 Key' : '绑定并读取 Key' }}</button></div>
      <pre><code>{{ configText }}</code></pre><button class="button button--primary" :disabled="!configText" @click="copyConfig"><IconCopy :size="16" />复制配置</button><p v-if="error" class="form-error">{{ error }}</p>
    </div></AppDrawer>
    <AppDrawer v-if="modelRelay" :open="Boolean(modelRelay)" wide kicker="RELAY MODELS" :title="`${modelRelay.name} · 模型`" @close="modelRelay = null"><section class="relay-model-drawer"><header><div><strong>{{ modelRelay.baseUrl }}</strong><small>{{ modelRelay.models.length }} 个模型 · {{ modelRelay.models.filter(model => model.enabled).length }} 个已启用</small></div><a class="button button--quiet button--small" :href="modelRelay.baseUrl" target="_blank" rel="noopener noreferrer"><IconExternalLink :size="14" />打开官网</a></header><div v-if="modelRelay.models.length" class="relay-model-catalog"><article v-for="model in modelRelay.models" :key="model.id || model.publicModel" :data-disabled="!model.enabled"><div><strong>{{ model.publicModel }}</strong><small v-if="model.upstreamModel !== model.publicModel">上游：{{ model.upstreamModel }}</small></div><div class="relay-model-meta"><span>{{ model.enabled ? '已启用' : '已停用' }}</span><code>{{ model.endpoints.length ? model.endpoints.map(endpoint => endpoint.replace('/v1/', '')).join(' · ') : '按协议支持' }}</code></div></article></div><div v-else class="admin-empty">该中转暂无模型</div></section></AppDrawer>
    <AppConfirmDialog :open="Boolean(testingCandidate)" title="执行协议检测" :message="`将对“${testingCandidate?.name || ''}”的每个协议发送最小推理请求；认证失败时会自动补测另一种认证，每个协议最多两次，上游可能计费。是否继续？`" confirm-label="开始检测" confirm-tone="primary" busy-label="检测中" @close="testingCandidate = null" @confirm="confirmTest" />
    <AppDrawer v-if="testReport" :open="Boolean(testReport)" kicker="PROTOCOL DIAGNOSTICS" :title="testReport.relayName" @close="testReport = null"><div class="relay-test-results"><article class="relay-connectivity-result" :data-ok="testReport.connectivity.ok"><div><strong>基础连接 · /v1/models</strong><span>{{ testReport.connectivity.ok ? '可达' : testReport.connectivity.reachable ? '接口异常' : '连接失败' }} · {{ testReport.connectivity.latencyMs }} ms</span></div><code>{{ testReport.connectivity.endpoint }}</code><small>{{ testReport.connectivity.modelCount }} 个模型 · 检测不会修改模型目录</small><p v-if="testReport.connectivity.errorCode || testReport.connectivity.message"><b v-if="testReport.connectivity.errorCode">{{ testReport.connectivity.errorCode }}</b>{{ testReport.connectivity.message }}</p></article><article v-for="result in testReport.results" :key="result.protocol" :data-ok="result.ok"><div><strong>{{ protocolLabel(result.protocol) }}</strong><span>{{ result.ok ? '通过' : result.clientIdentityRejected ? '等待真实客户端' : '失败' }} · {{ result.latencyMs }} ms</span></div><code>{{ result.endpoint }}</code><small>采用 {{ result.authScheme === 'bearer' ? 'Bearer' : 'x-api-key' }}<template v-if="result.attemptedAuthSchemes.length > 1"> · 已自动测试 Bearer 与 x-api-key</template><template v-if="result.clientIdentityProbed"> · 使用兼容客户端身份</template></small><p v-if="result.clientIdentityRejected">上游仍拒绝兼容客户端身份，请使用真实 Claude Code / Codex 请求完成验证。</p><p v-else-if="result.errorCode || result.message"><b v-if="result.errorCode">{{ result.errorCode }}</b>{{ result.message }}</p></article></div></AppDrawer>
    <AppConfirmDialog :open="Boolean(deleting)" title="删除中转" :message="`删除“${deleting?.name || ''}”后，绑定它的专用 Key 将不再有可用渠道。`" :busy="busy" @close="deleting = null" @confirm="remove" />
    <AppConfirmDialog :open="Boolean(deletingGroup)" title="删除整个站点" :message="`将永久删除“${deletingGroup?.name || ''}”及其 ${deletingGroup?.accounts.length || 0} 个账号、凭据和模型配置。此操作不可撤销。`" confirm-label="删除站点与全部账号" confirm-tone="danger" :busy="busy" @close="deletingGroup = null" @confirm="removeGroup" />
  </div>
</template>

<style scoped>
.relay-page { width:100%; }
.resource-panel-header { min-height:72px; margin-bottom:.65rem; display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
.resource-panel-header h2 { margin-top:.25rem; font-size:1.25rem; }
.resource-panel-header p { margin-top:.35rem; color:var(--text-muted); font-size:.78rem; }
.resource-panel-actions { display:flex; align-items:center; gap:.55rem; }
.relay-ledger { display:grid; gap:.65rem; }
.relay-site-tabs { margin-bottom:.8rem; display:flex; gap:.25rem; overflow-x:auto; border-bottom:1px solid var(--line-subtle); scrollbar-width:thin; }
.relay-site-tabs > button { min-width:170px; max-width:250px; min-height:54px; padding:.55rem .7rem; border:0; border-bottom:2px solid transparent; display:grid; align-content:center; justify-items:start; gap:.2rem; color:var(--text-muted); background:transparent; text-align:left; }
.relay-site-tabs > button:hover { color:var(--text); background:var(--surface-soft); }
.relay-site-tabs > button.active { border-bottom-color:var(--accent); color:var(--text); background:var(--surface); }
.relay-site-tabs strong,.relay-site-tabs small { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.relay-site-tabs strong { font-size:.76rem; }
.relay-site-tabs small { color:var(--text-muted); font-size:.62rem; }
.relay-group-tabs { margin-bottom:1rem; display:grid; gap:.55rem; }
.relay-group-summary { overflow:hidden; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface); }
.relay-group-summary > header { min-height:58px; padding:.65rem .8rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--line-subtle); }
.relay-group-summary > header > div:first-child { min-width:0; display:grid; gap:.18rem; }
.relay-group-summary > header strong { font-size:.84rem; }
.relay-group-summary > header strong a { display:inline-flex; align-items:center; gap:.3rem; color:inherit; text-decoration:none; }
.relay-group-summary > header strong a:hover { color:var(--accent); }
.relay-group-summary > header small { color:var(--text-muted); font-size:.67rem; }
.relay-group-actions { display:flex; align-items:center; gap:.35rem; }
.relay-group-actions select { min-width:120px; }
.relay-account-tabs { padding:.45rem; display:flex; gap:.35rem; overflow-x:auto; }
.relay-account-tab { min-width:150px; border:1px solid var(--line-subtle); border-radius:4px; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:stretch; color:var(--text-muted); background:var(--surface-soft); }
.relay-account-tab.active { border-color:var(--accent); color:var(--text); box-shadow:inset 0 -2px var(--accent); }
.relay-account-tab.dragging { opacity:.5; }
.relay-drag-handle { align-self:center; margin-left:.35rem; cursor:grab; }
.relay-account-tab > button { min-width:0; min-height:44px; padding:.4rem .55rem; border:0; display:grid; justify-items:start; gap:.15rem; color:inherit; background:transparent; }
.relay-tab-order { padding:.25rem; display:grid; align-content:center; gap:.1rem; border-left:1px solid var(--line-subtle); }
.relay-tab-order button { width:22px; height:18px; padding:0; border:0; display:grid; place-items:center; color:var(--text-muted); background:transparent; }
.relay-tab-order button:disabled { opacity:.25; }
.relay-account-tab > button > span { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.72rem; font-weight:700; }
.relay-account-tabs small { color:var(--text-muted); font-size:.62rem; }
.relay-row { min-height:96px; display:grid; grid-template-columns:minmax(220px,1.15fr) minmax(170px,.8fr) minmax(120px,.55fr) minmax(150px,.75fr) auto; gap:1rem; align-items:center; padding:1rem; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface); }
.relay-group-summary > .relay-row { border-width:1px 0 0; border-radius:0; }
.relay-balance { min-width:0; display:grid; gap:.2rem; }
.relay-balance strong { color:var(--hub-accent); font-family:var(--font-mono); font-size:.86rem; }
.relay-balance small { overflow:hidden; color:var(--hub-text-faint); font-size:.64rem; text-overflow:ellipsis; white-space:nowrap; }
.relay-identity { min-width:0; display:flex; align-items:center; gap:.75rem; }
.relay-identity > span { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--line-strong); color:var(--accent); background:var(--surface-soft); }
.relay-identity > div,.relay-health { min-width:0; display:grid; gap:.2rem; }
.relay-identity code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); font-size:.72rem; }
.relay-url { min-width:0; display:flex; align-items:center; gap:.25rem; overflow:hidden; color:var(--accent); font: .72rem/1.3 var(--font-mono); text-decoration:none; text-overflow:ellipsis; white-space:nowrap; }
.relay-url:hover { text-decoration:underline; }
.relay-identity small,.relay-health small { color:var(--text-muted); font-size:.72rem; }
.relay-protocols { display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-protocols span { display:inline-flex; align-items:center; gap:.35rem; min-height:28px; padding:0 .55rem; border:1px solid var(--line-subtle); border-radius:4px; font-size:.7rem; }
.relay-protocols i { width:6px; height:6px; border-radius:50%; background:var(--text-muted); }
.relay-protocols span[data-status="verified"] i { background:#1a8b62; }
.relay-protocols span[data-status="failed"] i { background:#c5483d; }
.relay-health em { max-width:260px; white-space:pre-wrap; overflow-wrap:anywhere; color:#b42318; font-size:.68rem; line-height:1.45; font-style:normal; }
.table-actions .is-complete { color:#1a8b62; }
.relay-model-button { flex:none; gap:.3rem; white-space:nowrap; }
.relay-model-button span { font-variant-numeric:tabular-nums; }
.relay-checkin > header { align-items:center; }
.relay-empty { min-height:260px; display:grid; place-items:center; align-content:center; gap:.55rem; text-align:center; }
.relay-empty p { margin:0; color:var(--text-muted); }
.protocol-picker { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.55rem; }
.protocol-option { min-width:0; border:1px solid var(--line-strong); background:var(--surface-soft); }
.protocol-option > button { width:100%; min-height:64px; display:flex; align-items:center; gap:.55rem; padding:.65rem; text-align:left; color:var(--text); border:0; background:transparent; }
.protocol-option > button > svg { flex:none; opacity:0; }
.protocol-option.active { border-color:var(--accent); background:color-mix(in srgb,var(--accent) 8%,var(--surface)); }
.protocol-option.active > button > svg { opacity:1; color:var(--accent); }
.protocol-option > button span { display:grid; gap:.15rem; }
.protocol-option__settings { padding:.55rem .65rem; border-top:1px solid var(--line-subtle); display:grid; gap:.55rem; }
.protocol-option__settings label { display:grid; gap:.35rem; color:var(--text-muted); font-size:.68rem; }
.relay-compat-settings { display:grid; gap:.75rem; }
.protocol-picker small { color:var(--text-muted); font-size:.68rem; }
.relay-key-input { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.5rem; }
.relay-secret-input { position:relative; min-width:0; display:block; }
.relay-secret-input input { width:100%; padding-right:2.7rem; }
.relay-secret-input .icon-button { position:absolute; top:50%; right:.3rem; width:30px; height:30px; border:0; background:transparent; transform:translateY(-50%); }
.relay-copy-target { display:grid; grid-template-columns:1fr 1fr; gap:.55rem; }
.relay-copy-target label { min-height:64px; padding:.7rem; border:1px solid var(--line-strong); display:flex; align-items:flex-start; gap:.55rem; color:var(--text-muted); background:var(--surface-soft); cursor:pointer; }
.relay-copy-target label.active { border-color:var(--accent); color:var(--text); }
.relay-copy-target label > span { display:grid; gap:.2rem; }
.relay-copy-target strong { font-size:.76rem; }
.relay-copy-target small { color:var(--text-muted); font-size:.67rem; line-height:1.4; }
.relay-group-move { display:grid; gap:.45rem; }
.relay-group-move > div { min-height:44px; display:grid; grid-template-columns:minmax(0,1fr) minmax(130px,180px); align-items:center; gap:.75rem; padding:.45rem 0; border-bottom:1px solid var(--line-subtle); }
.relay-group-move > div > span { min-width:0; display:grid; gap:.15rem; }
.relay-group-move > div strong,.relay-group-move > div small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.relay-group-move > div strong { font-size:.72rem; }
.relay-group-move > div small { color:var(--text-muted); font-size:.64rem; }
.relay-group-move > footer { display:flex; justify-content:flex-end; gap:.5rem; }
.relay-http-warning { padding:.7rem; border:1px solid color-mix(in srgb,#c07a16 55%,var(--line)); display:flex!important; grid-template-columns:auto 1fr!important; align-items:flex-start; gap:.55rem!important; color:#9a5e0a!important; background:color-mix(in srgb,#fff4d8 70%,var(--surface)); }
.relay-key-input .button { min-width:7.2rem; }
.relay-discovered { gap:.65rem; }
.relay-model-badges { max-height:8rem; overflow:auto; display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-model-badges span { max-width:100%; padding:.22rem .45rem; overflow:hidden; border:1px solid var(--line-subtle); border-radius:3px; color:var(--text-muted); background:var(--surface-soft); font: .65rem/1.35 var(--font-mono); text-overflow:ellipsis; white-space:nowrap; }
.relay-mappings > header { min-height:2.25rem; }
.relay-section-toggle { min-width:0; padding:0; border:0; display:flex; align-items:center; gap:.5rem; color:var(--text); background:transparent; text-align:left; }
.relay-section-toggle > span { min-width:0; display:grid; gap:.12rem; }
.relay-section-toggle strong { font-size:.78rem; }
.relay-section-toggle small { color:var(--text-muted); font-size:.68rem; font-weight:400; }
.relay-model-list { display:grid; gap:.5rem; }
.relay-model-entry { display:grid; gap:.4rem; padding:.55rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.relay-model-row { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto; gap:.5rem; align-items:center; }
.relay-model-row > span { color:var(--text-muted); }
.relay-model-protocols { display:flex; flex-wrap:wrap; gap:.35rem; }
.relay-model-protocols button { min-height:28px; padding:0 .5rem; border:1px solid var(--line-strong); color:var(--text-muted); background:var(--surface); font-size:.66rem; }
.relay-model-protocols button svg { opacity:0; }
.relay-model-protocols button.active { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb,var(--accent) 7%,var(--surface)); }
.relay-model-protocols button.active svg { opacity:1; }
.relay-settings-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
.config-builder { display:grid; gap:1rem; padding:1.1rem; }
.config-builder > label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.75rem; }
.config-tabs { display:grid; grid-template-columns:1fr 1fr; border:1px solid var(--line-strong); }
.config-tabs button { min-height:38px; border:0; background:transparent; color:var(--text-muted); }
.config-tabs button.active { color:var(--text); background:var(--surface-soft); box-shadow:inset 0 -2px var(--accent); }
.key-choice { display:grid; grid-template-columns:1fr 1fr; gap:.65rem; }
.key-choice label { display:grid; gap:.4rem; color:var(--text-muted); font-size:.75rem; }
.key-provision { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.75rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.key-provision > div { display:flex; align-items:center; gap:.6rem; }
.key-provision span { display:grid; gap:.15rem; }
.key-provision small { color:var(--text-muted); font-size:.7rem; }
.config-builder pre { min-height:190px; max-height:320px; overflow:auto; margin:0; padding:1rem; border:1px solid var(--line-strong); background:#111714; color:#dce8e0; font:12px/1.65 var(--font-mono); }
.relay-test-results { display:grid; gap:.65rem; padding:1rem; }
.relay-test-results article { display:grid; gap:.45rem; padding:.8rem; border:1px solid #efb9b4; background:#fff7f6; }
.relay-test-results article[data-ok="true"] { border-color:#a8d9c6; background:#f3fbf7; }
.relay-test-results article > div { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.relay-test-results article span,.relay-test-results code { color:var(--text-muted); font-size:.72rem; }
.relay-test-results code,.relay-test-results p { overflow-wrap:anywhere; white-space:pre-wrap; }
.relay-test-results p { display:grid; gap:.25rem; margin:0; color:#9f2f27; font-size:.75rem; line-height:1.5; }
.relay-test-results b { font-family:var(--font-mono); }
.relay-model-drawer { display:grid; gap:1rem; }
.relay-model-drawer > header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; padding:.8rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.relay-model-drawer > header > div { min-width:0; display:grid; gap:.25rem; }
.relay-model-drawer > header strong { overflow:hidden; color:var(--text); font: .72rem/1.4 var(--font-mono); text-overflow:ellipsis; white-space:nowrap; }
.relay-model-drawer > header small { color:var(--text-muted); font-size:.7rem; }
.relay-model-catalog { display:grid; gap:.45rem; }
.relay-model-catalog article { display:flex; align-items:center; justify-content:space-between; gap:1rem; min-width:0; padding:.7rem .8rem; border:1px solid var(--line-subtle); background:var(--surface); }
.relay-model-catalog article[data-disabled="true"] { opacity:.58; }
.relay-model-catalog article > div:first-child { min-width:0; display:grid; gap:.2rem; }
.relay-model-catalog strong { overflow:hidden; font-size:.76rem; text-overflow:ellipsis; white-space:nowrap; }
.relay-model-catalog small,.relay-model-meta { color:var(--text-muted); font-size:.66rem; }
.relay-model-meta { flex:none; display:grid; justify-items:end; gap:.2rem; text-align:right; }
.relay-model-meta code { max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:900px) { .relay-row { grid-template-columns:1fr auto; } .relay-protocols,.relay-health,.relay-balance { grid-column:1 / -1; } }
@media (max-width:640px) { .resource-panel-header { align-items:stretch; flex-direction:column; } .resource-panel-actions { width:100%; flex-wrap:wrap; } .resource-panel-actions .button { flex:1 1 auto; } .relay-group-summary > header { align-items:flex-start; flex-direction:column; } .relay-group-actions { width:100%; flex-wrap:wrap; } .relay-group-actions .app-select { flex:1 1 150px; } .protocol-picker,.key-choice,.relay-settings-grid,.relay-key-input,.relay-copy-target { grid-template-columns:1fr; } .relay-row { grid-template-columns:1fr; } .relay-row > .table-actions { justify-content:flex-end; flex-wrap:wrap; } .relay-model-row { grid-template-columns:1fr auto; } .relay-model-row > span { display:none; } .key-provision { align-items:flex-start; flex-direction:column; } .relay-model-catalog article { align-items:flex-start; flex-direction:column; gap:.45rem; } .relay-model-meta { justify-items:start; text-align:left; } .relay-model-meta code { max-width:100%; } }
</style>
