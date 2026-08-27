<script setup lang="ts">
import { IconBraces, IconCalendarCheck, IconCheck, IconChecks, IconChevronDown, IconChevronUp, IconCloudDownload, IconCode, IconCopy, IconEdit, IconExternalLink, IconEye, IconEyeOff, IconGripVertical, IconKey, IconPlugConnected, IconPlus, IconRefresh, IconServerBolt, IconSettings, IconTrash, IconWallet, IconX } from '@tabler/icons-vue'
import type { ChannelModelView, ChannelProtocol, ChannelProtocolBindingView, ChannelView, HubKeyView, RelayModelScope, RelayPlatformType, UserModelRoutePolicyView, UserRelayAccountView, UserRelayGroupView } from '#shared/types/hub'
import { relayProviderPresets } from '#shared/relay-provider-presets'

const { data, refresh, status: relayStatus } = useLazyFetch<{ groups: UserRelayGroupView[] }>('/api/console/relay-groups')
const { data: keyData, refresh: refreshKeys } = useLazyFetch<{ keys: HubKeyView[] }>('/api/console/keys')
const { data: routingData, execute: loadRouting, refresh: refreshRouting } = useLazyFetch<{ models: string[]; radar: { enabled: boolean; maxEffort: string }; policies: UserModelRoutePolicyView[] }>('/api/console/model-routing', { immediate: false })
const { data: radarData, execute: loadRadar } = useLazyFetch<{ models: Array<{ model: string; reasoningEffort: string; intelligenceScore: number }>; updatedAt: number | null }>('/api/codex-radar', { immediate: false })
const toast = useAppToast()
const busy = ref(false)
const discovering = ref(false)
const discoveredModels = ref<string[]>([])
const mappingsExpanded = ref(false)
const testing = ref<string | null>(null)
const connectivityTesting = ref<string | null>(null)
const selectedPresetId = ref('')
const testingCandidate = ref<ChannelView | null>(null)
interface RelayTestResult { protocol: ChannelProtocol; endpoint: string; ok: boolean; status: number | null; latencyMs: number; errorCode: string | null; message: string | null; authScheme: 'bearer' | 'x_api_key'; attemptedAuthSchemes: Array<'bearer' | 'x_api_key'>; clientIdentityRejected: boolean; clientIdentityProbed: boolean }
interface RelayConnectivity { endpoint: string; ok: boolean; reachable: boolean; status: number | null; latencyMs: number; errorCode: string | null; message: string | null; modelCount: number; authScheme: 'bearer' | 'x_api_key'; attemptedAuthSchemes: Array<'bearer' | 'x_api_key'>; clientIdentityProbed?: boolean }
const testReport = ref<{ relayName: string; healthy: boolean; summaryStatus: string; connectivity: RelayConnectivity; results: RelayTestResult[] } | null>(null)
const syncing = ref<string | null>(null)
const checkingIn = ref<string | null>(null)
const checkingInAll = ref(false)
const deleting = ref<ChannelView | null>(null)
const editing = ref<ChannelView | null>(null)
const showForm = ref(false)
const configuring = ref<ChannelView | null>(null)
const modelRelay = ref<ChannelView | null>(null)
const modelTesting = ref<string | null>(null)
const configMode = ref<'claude' | 'codex'>('claude')
const configModel = ref('')
const generatedKey = ref('')
const selectedKeyId = ref('new')
const error = ref('')
interface RelayBalance { id: string; name: string; quota: number | null; usedQuota: number | null; remaining: number | null; currency: string | null; fetchedAt: number; error?: string }
const balances = ref<Record<string, RelayBalance>>({})
const balanceLoading = ref<string | null>(null)
const balanceRefreshingAll = ref(false)

const scopeOptions: Array<{ id: RelayModelScope; label: string; detail: string }> = [{ id: 'gpt', label: 'GPT', detail: 'Codex / OpenAI 模型' }, { id: 'claude', label: 'Claude', detail: 'Claude Code 模型' }, { id: 'other', label: '其他厂商', detail: '获取模型后自动识别厂商' }]
const form = reactive({ name: '', accountLabel: '', groupId: '', groupName: '', homepageUrl: '', platformType: 'generic' as RelayPlatformType, providerPresetId: '', modelScopes: ['gpt'] as RelayModelScope[], baseUrl: '', apiKey: '', protocols: [] as ChannelProtocolBindingView[], models: [] as ChannelModelView[], enabled: true, weight: 1, maxConcurrency: 5, timeoutMs: 120000, checkinEnabled: false, checkinToken: '', checkinUserId: '', insecureHttpAcknowledged: false, clientIdentityMode: 'standard' as 'standard' | 'passthrough' })
const relays = computed<UserRelayAccountView[]>(() => data.value?.groups.flatMap(group => group.accounts) || [])
const checkinCount = computed(() => relays.value.filter(item => item.checkinEnabled && item.checkinConfigured).length || 0)
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
let activeAccountPointer: { group: UserRelayGroupView; accountId: string; targetId: string; pointerId: number } | null = null
const movingAccount = ref<string | null>(null)
const mergeTargetId = ref('')
const groupFor = (item: ChannelView) => data.value?.groups.find(group => group.id === item.userRelayGroupId) || null
interface RouteSourceView { id: string; name: string; sourceType: string }
interface RoutePolicyEditor { requestedModel: string; substitutionEnabled: boolean; substitutes: string[]; newSubstitute: string; modes: Record<string, 'manual' | 'price_asc'>; sourceOrders: Record<string, string[]> }
const { data: routeSourceData, execute: loadRouteSources } = useLazyFetch<{ sources: RouteSourceView[] }>('/api/console/relay-order', { immediate: false })
const routingOpen = ref(false)
const routingSaving = ref(false)
const routePolicies = ref<RoutePolicyEditor[]>([])
const radarForm = reactive({ enabled: false, maxEffort: 'high' })
const draggedSubstitute = ref<{ policy: number; model: string } | null>(null)
const draggedSource = ref<{ policy: number; model: string; sourceId: string } | null>(null)

function sourceName(id: string) { return routeSourceData.value?.sources.find(item => item.id === id)?.name || id }
function policyModels(policy: RoutePolicyEditor) { return [policy.requestedModel, ...(policy.substitutionEnabled ? policy.substitutes : [])].filter(Boolean) }
function ensurePolicyLane(policy: RoutePolicyEditor, model: string) {
  policy.modes[model] ||= 'manual'
  policy.sourceOrders[model] ||= routeSourceData.value?.sources.map(item => item.id) || []
}
async function openRouting() {
  routingOpen.value = true
  await Promise.all([loadRouting(), loadRouteSources(), loadRadar()])
  Object.assign(radarForm, routingData.value?.radar || { enabled: false, maxEffort: 'high' })
  routePolicies.value = (routingData.value?.policies || []).map(item => {
    const modes: RoutePolicyEditor['modes'] = {}
    const sourceOrders: RoutePolicyEditor['sourceOrders'] = {}
    for (const source of item.sources) { modes[source.actualModel] = source.orderMode; sourceOrders[source.actualModel] = [...source.orderedSourceIds] }
    const policy = { requestedModel: item.requestedModel, substitutionEnabled: item.substitutionEnabled, substitutes: [...item.orderedSubstituteModels], newSubstitute: '', modes, sourceOrders }
    for (const model of [policy.requestedModel, ...policy.substitutes]) ensurePolicyLane(policy, model)
    return policy
  })
}
function addRoutePolicy() { routePolicies.value.push({ requestedModel: '', substitutionEnabled: false, substitutes: [], newSubstitute: '', modes: {}, sourceOrders: {} }) }
function addSubstitute(policy: RoutePolicyEditor) { const model = policy.newSubstitute.trim(); if (!model || model === policy.requestedModel || policy.substitutes.includes(model)) return; policy.substitutes.push(model); policy.newSubstitute = ''; ensurePolicyLane(policy, model) }
function dropSubstitute(policyIndex: number, target: string) {
  const dragged = draggedSubstitute.value
  if (!dragged || dragged.policy !== policyIndex || dragged.model === target) return
  const list = routePolicies.value[policyIndex]!.substitutes
  const from = list.indexOf(dragged.model); const to = list.indexOf(target)
  if (from >= 0 && to >= 0) list.splice(to, 0, ...list.splice(from, 1))
  draggedSubstitute.value = null
}
function dropSource(policyIndex: number, model: string, targetId: string) {
  const dragged = draggedSource.value
  if (!dragged || dragged.policy !== policyIndex || dragged.model !== model || dragged.sourceId === targetId) return
  const list = routePolicies.value[policyIndex]!.sourceOrders[model] || []
  const from = list.indexOf(dragged.sourceId); const to = list.indexOf(targetId)
  if (from >= 0 && to >= 0) list.splice(to, 0, ...list.splice(from, 1))
  draggedSource.value = null
}
async function saveRouting() {
  routingSaving.value = true
  try {
    const policies = routePolicies.value.filter(item => item.requestedModel.trim()).map(item => ({ requestedModel: item.requestedModel.trim(), substitutionEnabled: item.substitutionEnabled, orderedSubstituteModels: item.substitutes, sources: policyModels(item).map(actualModel => ({ actualModel, orderMode: item.modes[actualModel] || 'manual', orderedSourceIds: item.sourceOrders[actualModel] || [] })) }))
    await $fetch('/api/console/model-routing', { method: 'PUT', body: { radar: radarForm, policies } })
    await refreshRouting(); routingOpen.value = false; toast.show('模型路由设置已保存', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '保存模型路由失败', 'error') }
  finally { routingSaving.value = false }
}

watch(() => form.platformType, (platform) => {
  if (!editing.value) {
    for (const protocol of form.protocols) protocol.authScheme = platform === 'generic' && protocol.protocol === 'anthropic_messages' ? 'x_api_key' : 'bearer'
  }
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
function reset() { Object.assign(form, { name: '', accountLabel: '', groupId: '', groupName: '', homepageUrl: '', platformType: 'generic', providerPresetId: '', modelScopes: ['gpt'], baseUrl: '', apiKey: '', protocols: [], models: [emptyModel()], enabled: true, weight: 1, maxConcurrency: 5, timeoutMs: 120000, checkinEnabled: false, checkinToken: '', checkinUserId: '', insecureHttpAcknowledged: false, clientIdentityMode: 'standard' }); selectedPresetId.value = ''; discoveredModels.value = []; mappingsExpanded.value = false; showApiKey.value = false; showCheckinToken.value = false; originalApiKey.value = ''; originalCheckinToken.value = '' }
function create(groupId?: string) { editing.value = null; reset(); addingToGroup.value = groupId || null; const group = groupId ? data.value?.groups.find(item => item.id === groupId) : null; if (group) Object.assign(form, { groupId: group.id, groupName: group.name, homepageUrl: group.homepageUrl || '', platformType: group.platformType }); error.value = ''; showForm.value = true }
async function edit(item: ChannelView) {
  editing.value = item
  addingToGroup.value = null
  const direct = item.models.filter(isDirectModel)
  const mapped = item.models.filter(model => !isDirectModel(model))
  discoveredModels.value = direct.map(model => model.upstreamModel)
  const group = groupFor(item)
  Object.assign(form, { name: item.name, accountLabel: item.accountLabel || item.name, groupId: item.userRelayGroupId || '', groupName: group?.name || '', homepageUrl: group?.homepageUrl || '', platformType: group?.platformType || 'generic', providerPresetId: item.providerPresetId || '', modelScopes: [...item.modelScopes], baseUrl: item.baseUrl, apiKey: '', protocols: item.protocols.map(protocol => ({ ...protocol })), models: mapped.length ? mapped.map(model => ({ ...model, endpoints: [...model.endpoints], protocolBindings: model.protocolBindings?.map(protocol => ({ ...protocol, capabilities: { ...protocol.capabilities } })) })) : [emptyModel()], enabled: item.enabled, weight: item.weight, maxConcurrency: item.maxConcurrency, timeoutMs: item.timeoutMs, checkinEnabled: item.checkinEnabled, checkinToken: '', checkinUserId: item.checkinUserId || '', insecureHttpAcknowledged: Boolean(item.insecureHttpAcknowledgedAt), clientIdentityMode: item.clientIdentityMode })
  mappingsExpanded.value = mapped.length > 0
  error.value = ''; credentialsLoading.value = true; showForm.value = true
  try {
    const credentials = await $fetch<{ apiKey: string; checkinToken: string; checkinUserId: string }>(`/api/console/relays/${item.id}/credentials`, { method: 'POST' })
    form.apiKey = credentials.apiKey; form.checkinToken = credentials.checkinToken; form.checkinUserId = credentials.checkinUserId || form.checkinUserId; originalApiKey.value = credentials.apiKey; originalCheckinToken.value = credentials.checkinToken
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '读取中转凭据失败' }
  finally { credentialsLoading.value = false }
}
function toggleScope(scope: RelayModelScope) {
  const index = form.modelScopes.indexOf(scope)
  if (index >= 0) form.modelScopes.splice(index, 1)
  else form.modelScopes.push(scope)
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
function setProtocolBaseUrl(protocol: ChannelProtocol, event: Event) {
  const item = selectedProtocol(protocol)
  if (item) item.baseUrlOverride = (event.target as HTMLInputElement).value || null
}
function probeModelsFor(protocol: ChannelProtocol) {
  return [...new Set([
    ...discoveredModels.value,
    ...form.models.map(model => model.upstreamModel.trim()).filter(Boolean)
  ])]
}
function applyPreset() {
  const preset = relayProviderPresets.find(item => item.id === selectedPresetId.value)
  if (!preset) { form.providerPresetId = ''; if (!form.modelScopes.length) form.modelScopes = ['gpt']; return }
  const protocols = preset.protocols.map(item => ({ ...binding(item.protocol), authScheme: item.authScheme, baseUrlOverride: item.baseUrlOverride || null, probeModel: probeModelsFor(item.protocol)[0] || null }))
  Object.assign(form, {
    providerPresetId: preset.id,
    modelScopes: preset.modelScopes || [],
    groupName: preset.name,
    name: preset.name,
    accountLabel: '账号 1',
    homepageUrl: preset.homepageUrl,
    baseUrl: preset.baseUrl,
    platformType: preset.platformType,
    protocols
  })
}
function body() {
  const mappedModels: ChannelModelView[] = form.models.filter(model => model.upstreamModel.trim()).map(model => ({
    ...model,
    publicModel: model.publicModel.trim() || model.upstreamModel.trim(),
    upstreamModel: model.upstreamModel.trim(),
    protocolBindings: undefined
  }))
  const discovered = discoveredModels.value.map(upstreamModel => ({ publicModel: upstreamModel, upstreamModel, enabled: true, endpoints: [] } satisfies ChannelModelView))
  const models = [...new Map([...discovered, ...mappedModels].map(model => [model.publicModel, model])).values()]
  return {
    name: form.name,
    accountLabel: form.accountLabel,
    baseUrl: form.baseUrl,
    ...(!editing.value || form.apiKey !== originalApiKey.value ? { apiKey: form.apiKey } : {}),
    providerPresetId: form.providerPresetId || undefined,
    modelScopes: form.modelScopes,
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
async function discoverModels() {
  if (!form.baseUrl || !form.apiKey && !editing.value) { error.value = '请先填写中转地址和 API Key'; return }
  discovering.value = true; error.value = ''
  try {
    const result = await $fetch<{ models: string[] }>('/api/console/relays/models/discover', { method: 'POST', body: { relayId: editing.value?.id, baseUrl: form.baseUrl, apiKey: form.apiKey, timeoutMs: form.timeoutMs } })
    discoveredModels.value = result.models
    for (const protocol of form.protocols) if (!protocol.probeModel && result.models[0]) protocol.probeModel = result.models[0]
    toast.show(`已获取 ${result.models.length} 个模型`, 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; error.value = failure.data?.message || failure.message || '获取模型失败' }
  finally { discovering.value = false }
}
function announceRelayChange() { if (import.meta.client) window.dispatchEvent(new Event('user-relays-changed')) }
async function save() {
  if (!form.providerPresetId && !form.modelScopes.length) { error.value = '请至少选择一个模型品类'; return }
  busy.value = true; error.value = ''
  let groupSaved = false
  try {
    if (editing.value?.userRelayGroupId) {
      const group = groupFor(editing.value)
      const groupChanged = !group
        || form.groupName !== group.name
        || form.homepageUrl !== (group.homepageUrl || '')
        || form.platformType !== group.platformType
      if (groupChanged) {
        await $fetch(`/api/console/relay-groups/${editing.value.userRelayGroupId}`, {
          method: 'PATCH',
          body: { name: form.groupName, homepageUrl: form.homepageUrl, platformType: form.platformType }
        })
        groupSaved = true
      }
    }
    const saved = editing.value
      ? await $fetch<ChannelView>(`/api/console/relays/${editing.value.id}`, { method: 'PATCH', body: body() })
      : await $fetch<ChannelView>('/api/console/relays', { method: 'POST', body: body() })
    showForm.value = false; await refresh(); announceRelayChange(); toast.show(editing.value ? '中转已更新' : saved.models.length ? `中转已添加，已保存 ${saved.models.filter(model => model.enabled).length} 个模型` : '中转已添加，可继续获取模型并执行协议检测', 'success')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; const message = failure.data?.message || failure.message || '保存失败'; error.value = groupSaved ? `站点资料已保存，但账号配置保存失败：${message}` : message }
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
  if (testing.value) {
    toast.show('已有协议检测正在执行，请等待完成', 'info')
    return
  }
  await test(item)
  testingCandidate.value = null
}
async function testConnectivity(item: ChannelView) {
  if (connectivityTesting.value) {
    const active = relays.value.find(relay => relay.id === connectivityTesting.value)
    toast.show(`正在检测“${active?.name || '其他中转'}”的连通性`, 'info')
    return
  }
  connectivityTesting.value = item.id
  try {
    const result = await $fetch<{ status: 'operational' | 'degraded' | 'failed'; success: boolean; message: string; responseTimeMs: number; httpStatus: number | null }>(`/api/console/relays/${item.id}/connectivity`, { method: 'POST' })
    if (result.success) {
      toast.show(`${item.name} ${result.status === 'degraded' ? '可以连通，但响应较慢' : '连通正常'}（${result.responseTimeMs} ms · HTTP ${result.httpStatus}）`, result.status === 'degraded' ? 'info' : 'success')
    } else {
      toast.show(`${item.name} 无法连通：${result.message}`, 'error')
    }
  } catch (value) {
    const failure = value as { data?: { message?: string }; message?: string }
    toast.show(failure.data?.message || failure.message || '连通检测失败', 'error')
  } finally { connectivityTesting.value = null }
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
async function testRelayModel(item: ChannelView, model: string) {
  if (modelTesting.value) return
  modelTesting.value = model
  try {
    const result = await $fetch<{ healthy: boolean; summaryStatus: string; connectivity: RelayConnectivity; results: RelayTestResult[] }>(`/api/console/relays/${item.id}/models/test`, { method: 'POST', body: { model } })
    testReport.value = { relayName: `${item.name} · ${model}`, ...result }; await refresh(); toast.show(result.healthy ? '模型测试已完成' : '模型测试未通过', result.healthy ? 'success' : 'error')
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; toast.show(failure.data?.message || failure.message || '模型测试失败', 'error') }
  finally { modelTesting.value = null }
}
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
    await $fetch(`/api/console/relays/${account.id}/move`, { method: 'POST', body: { targetGroupId } })
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
function startAccountDrag(group: UserRelayGroupView, accountId: string, event: PointerEvent) {
  if (movingAccount.value || event.button !== 0) return
  event.preventDefault()
  activeAccountPointer = { group, accountId, targetId: accountId, pointerId: event.pointerId }
  draggedAccount.value = { groupId: group.id, accountId }
  window.addEventListener('pointermove', moveAccountDrag, { passive: false })
  window.addEventListener('pointerup', finishAccountDrag, { passive: false })
  window.addEventListener('pointercancel', cancelAccountDrag)
}
function moveAccountDrag(event: PointerEvent) {
  if (!activeAccountPointer || activeAccountPointer.pointerId !== event.pointerId) return
  event.preventDefault()
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-relay-account-id]')
  if (target?.dataset.relayGroupId === activeAccountPointer.group.id && target.dataset.relayAccountId) activeAccountPointer.targetId = target.dataset.relayAccountId
}
function finishAccountDrag(event: PointerEvent) {
  if (!activeAccountPointer || activeAccountPointer.pointerId !== event.pointerId) return
  event.preventDefault()
  const active = activeAccountPointer
  removeAccountDragListeners()
  activeAccountPointer = null
  void dropAccount(active.group, active.targetId)
}
function cancelAccountDrag(event: PointerEvent) {
  if (!activeAccountPointer || activeAccountPointer.pointerId !== event.pointerId) return
  removeAccountDragListeners()
  activeAccountPointer = null
  draggedAccount.value = null
}
function removeAccountDragListeners() {
  window.removeEventListener('pointermove', moveAccountDrag)
  window.removeEventListener('pointerup', finishAccountDrag)
  window.removeEventListener('pointercancel', cancelAccountDrag)
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
onBeforeUnmount(removeAccountDragListeners)
async function openDuplicate(item: ChannelView) {
  duplicating.value = item; duplicateLoading.value = true; duplicateError.value = ''; showDuplicateApiKey.value = false; showDuplicateCheckinToken.value = false
  const group = groupFor(item)
  Object.assign(duplicateForm, { newGroup: false, name: `${item.name} - 副本`, accountLabel: `${item.accountLabel || item.name} - 副本`, groupName: `${group?.name || item.name} - 副本`, homepageUrl: group?.homepageUrl || item.baseUrl, platformType: group?.platformType || 'generic', baseUrl: item.baseUrl, apiKey: '', checkinToken: '', checkinUserId: item.checkinUserId || '', enabled: true })
  try {
    const credentials = await $fetch<{ apiKey: string; checkinToken: string; checkinUserId: string }>(`/api/console/relays/${item.id}/credentials`, { method: 'POST' })
    duplicateForm.apiKey = credentials.apiKey; duplicateForm.checkinToken = credentials.checkinToken; duplicateForm.checkinUserId = credentials.checkinUserId || duplicateForm.checkinUserId
  } catch (value) { const failure = value as { data?: { message?: string }; message?: string }; duplicateError.value = failure.data?.message || failure.message || '读取中转凭据失败' }
  finally { duplicateLoading.value = false }
}
async function duplicateRelay() {
  const item = duplicating.value
  if (!item) return
  busy.value = true; duplicateError.value = ''
  try {
    await $fetch(`/api/console/relays/${item.id}/duplicate`, { method: 'POST', body: { ...duplicateForm } })
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
function accountCapabilitySummary(account: ChannelView) {
  const scopes = account.modelScopes.map(scope => scope === 'gpt' ? 'GPT' : scope === 'claude' ? 'Claude' : '其他厂商').join(' / ') || '品类待设置'
  const verified = account.protocols.filter(item => item.enabled && item.verificationStatus === 'verified').map(item => item.protocol === 'openai_chat' && item.capabilityMode === 'responses_via_chat' ? 'Responses→Chat' : protocolLabel(item.protocol)).join(' · ')
  const state = account.healthStatus === 'healthy' ? '可用' : account.healthStatus === 'unhealthy' ? '需处理' : '待检测'
  return `${scopes} · ${verified || state} · ${date(account.lastHealthCheckAt)}`
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
    <header class="resource-panel-header"><div><span class="admin-kicker">PRIVATE RELAY GROUPS</span><h2>我的中转</h2><p>每个站点是一个故障转移节点，站点内账号按列表顺序依次使用。</p></div><div class="resource-panel-actions"><button class="button button--quiet button--small" @click="openRouting"><IconSettings :size="15" />模型路由</button><button class="button button--quiet button--small" :disabled="balanceRefreshingAll" @click="refreshBalances"><IconWallet :size="15" />{{ balanceRefreshingAll ? '查询中' : '刷新余额' }}</button><button class="button button--secondary" :disabled="!checkinCount || checkingInAll" @click="checkinAll"><IconChecks :size="17" />{{ checkingInAll ? '签到中' : '一键签到' }}</button><button class="button button--primary" @click="create()"><IconPlus :size="17" />添加站点</button></div></header>
    <section v-if="data?.groups.length" class="relay-group-list">
      <article v-for="group in data.groups" :key="group.id" class="relay-group-summary">
        <header><div><strong><a v-if="group.homepageUrl" :href="group.homepageUrl" target="_blank" rel="noopener noreferrer">{{ group.name }}<IconExternalLink :size="12" /></a><template v-else>{{ group.name }}</template></strong><small>{{ group.platformType === 'newapi' ? 'NewAPI' : group.platformType === 'sub2api' ? 'Sub2API' : '通用兼容站' }} · {{ group.accounts.filter(account => account.state.routingState === 'active').length }}/{{ group.accounts.length }} 可用 · {{ groupModelCount(group) }} 模型 · {{ groupBalanceSummary(group) }}</small><small>{{ groupCapabilitySummary(group) }}</small></div><div class="relay-group-actions"><AppSelect :model-value="group.accountOrderMode" aria-label="账号排序" @update:model-value="setGroupOrder(group, $event)"><option value="manual">手工顺序</option><option value="balance_desc">余额降序</option><option value="balance_asc">余额升序</option></AppSelect><button class="icon-button" title="添加账号" aria-label="添加账号" @click="create(group.id)"><IconPlus :size="15" /></button><button class="icon-button" title="刷新站点余额" aria-label="刷新站点余额" :disabled="balanceRefreshingAll || group.platformType === 'generic'" @click="refreshUserRelayGroupBalances(group.id)"><IconWallet :size="15" /></button><button class="icon-button" title="站点设置" aria-label="站点设置" @click="openGroupSettings(group)"><IconSettings :size="15" /></button></div></header>
        <div class="relay-account-list">
          <article
            v-for="(account, index) in group.accounts"
            :key="account.id"
            class="relay-row"
            :class="{ 'is-draggable': group.accountOrderMode === 'manual', 'is-dragging': draggedAccount?.accountId === account.id }"
            :data-relay-group-id="group.id"
            :data-relay-account-id="account.id"
          >
            <button v-if="group.accountOrderMode === 'manual'" type="button" class="relay-row-drag" :aria-label="`拖拽调整 ${account.accountLabel || account.name} 的顺序`" title="拖拽调整账号顺序" @pointerdown="startAccountDrag(group, account.id, $event)"><IconGripVertical :size="17" /><span>{{ index + 1 }}</span></button>
            <div class="relay-identity"><span><IconServerBolt :size="19" /></span><div><strong>{{ account.accountLabel || account.name }}</strong><a class="relay-url" :href="account.baseUrl" target="_blank" rel="noopener noreferrer" :title="`打开 ${account.baseUrl}`"><IconExternalLink :size="12" />{{ account.baseUrl }}</a><small>{{ account.name }} · 仅自己 · {{ account.models.filter(model => model.enabled).length }} 个模型</small></div></div>
            <small class="relay-capability-line" :title="account.lastHealthError || accountCapabilitySummary(account)">{{ accountCapabilitySummary(account) }}</small>
            <div class="relay-balance"><template v-if="account.state.balanceError"><strong>查询失败</strong><small :title="account.state.balanceError || undefined">{{ account.state.balanceError }}</small></template><template v-else-if="account.state.balanceStatus === 'success'"><strong>{{ formatBalance(account.state.remainingBalance, account.state.currency) }}</strong><small>购买 {{ formatBalance(account.state.purchasedQuota, account.state.currency) }} · 赠送 {{ formatBalance(account.state.giftQuota, account.state.currency) }}</small></template><template v-else><strong>余额待查</strong><small>{{ group.platformType === 'generic' ? '通用站未配置余额接口' : '点击刷新余额' }}</small></template></div>
            <div class="table-actions"><button class="button button--quiet button--small relay-model-button" :disabled="!account.models.length" @click="openModels(account)"><IconBraces :size="14" />查看模型 <span>{{ account.models.filter(model => model.enabled).length }}</span></button><button class="icon-button" title="刷新余额" :aria-label="`${account.name} 刷新余额`" :disabled="balanceLoading === account.id || group.platformType === 'generic' || (group.platformType === 'newapi' && !account.checkinConfigured)" @click="refreshBalance(account)"><IconWallet :size="16" /></button><button v-if="account.checkinEnabled && account.checkinConfigured" class="icon-button" :class="{ 'is-complete': checkedInToday(account) }" :title="checkedInToday(account) ? '今日已签到' : '签到'" :aria-label="`${account.name} ${checkedInToday(account) ? '今日已签到' : '签到'}`" :disabled="checkingIn === account.id || checkedInToday(account)" @click="checkin(account)"><IconCalendarCheck :size="17" /></button><button class="icon-button" :title="connectivityTesting === account.id ? '正在检测连通' : '检测连通'" :aria-label="`${account.name} 检测连通`" :disabled="Boolean(connectivityTesting)" @click="testConnectivity(account)"><IconPlugConnected :class="{ 'is-spinning': connectivityTesting === account.id }" :size="17" /></button><button class="icon-button" :title="testing === account.id ? '协议检测正在执行' : '协议检测'" :aria-label="testing === account.id ? `${account.name} 协议检测正在执行` : `${account.name} 协议检测`" :aria-busy="testing === account.id" @click="requestTest(account)"><IconRefresh :class="{ 'is-spinning': testing === account.id }" :size="17" /></button><button class="icon-button" title="同步模型" aria-label="同步模型" :disabled="syncing === account.id" @click="sync(account)"><IconCloudDownload :size="17" /></button><button class="icon-button" title="复制中转" aria-label="复制中转" @click="openDuplicate(account)"><IconCopy :size="17" /></button><button class="icon-button" title="生成客户端配置" aria-label="生成客户端配置" @click="openConfig(account)"><IconCode :size="17" /></button><button class="icon-button" title="编辑" aria-label="编辑中转" @click="edit(account)"><IconEdit :size="17" /></button><button class="icon-button danger" title="删除" aria-label="删除中转" @click="deleting = account"><IconTrash :size="17" /></button></div>
          </article>
        </div>
      </article>
    </section>
    <div v-if="relayStatus === 'pending' && !data" class="admin-empty relay-empty"><IconRefresh class="is-spinning" :size="24" /><strong>正在加载中转站点</strong></div>
    <div v-else-if="!data?.groups.length" class="admin-empty relay-empty"><IconServerBolt :size="26" /><strong>还没有私有中转</strong><p>添加一个支持 Messages、Responses 或 Chat 的站点。</p><button class="button button--primary button--small" @click="create()">添加第一个站点</button></div>

    <AppDrawer :open="showForm" kicker="PRIVATE RELAY" :title="editing ? '编辑中转' : '添加中转'" @close="showForm = false"><form class="admin-form" autocomplete="off" @submit.prevent="save">
      <label v-if="!editing"><span>预设服务商</span><AppSelect v-model="selectedPresetId" @update:model-value="applyPreset"><option value="">自定义</option><optgroup label="官方服务"><option v-for="preset in relayProviderPresets.filter(item => item.category === 'official')" :key="preset.id" :value="preset.id">{{ preset.name }}</option></optgroup><optgroup label="国内官方"><option v-for="preset in relayProviderPresets.filter(item => item.category === 'cn_official')" :key="preset.id" :value="preset.id">{{ preset.name }}</option></optgroup><optgroup label="第三方与聚合"><option v-for="preset in relayProviderPresets.filter(item => item.category === 'third_party' || item.category === 'aggregator')" :key="preset.id" :value="preset.id">{{ preset.name }}</option></optgroup></AppSelect><small>选择后自动填写站点、地址和协议，API Key 不会被覆盖</small></label>
      <div class="form-grid"><label><span>站点名称 *</span><input v-model="form.groupName" :disabled="Boolean(addingToGroup)" required placeholder="例如：AgentRouter"></label><label><span>平台 *</span><AppSelect v-model="form.platformType" :disabled="Boolean(addingToGroup)"><option value="generic">通用兼容站</option><option value="newapi">NewAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
      <label><span>站点官网</span><input v-model="form.homepageUrl" type="url" :disabled="Boolean(addingToGroup)" placeholder="https://relay.example.com"><small v-if="addingToGroup">该资料由所属站点统一管理</small></label>
      <div class="form-grid"><label><span>账号名称 *</span><input v-model="form.name" required placeholder="例如：主账号"></label><label><span>账号标签</span><input v-model="form.accountLabel" placeholder="用于账号 Tab 和日志"></label></div>
      <label for="relay-upstream-origin"><span>Base URL *</span><input id="relay-upstream-origin" v-model="form.baseUrl" name="relay_upstream_origin" type="url" required autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="https://relay.example.com 或 http://relay.example.com"></label>
      <label v-if="form.baseUrl.startsWith('http://')" class="relay-http-warning"><input v-model="form.insecureHttpAcknowledged" type="checkbox"><span>我确认该站点使用明文 HTTP，API Key、请求和响应可能被读取或篡改。</span></label>
      <label for="relay-upstream-token"><span>上游 API Key *</span><span class="relay-key-input"><span class="relay-secret-input"><input id="relay-upstream-token" v-model="form.apiKey" name="relay_upstream_token" :type="showApiKey ? 'text' : 'password'" :disabled="credentialsLoading" :placeholder="credentialsLoading ? '正在读取凭据…' : ''" required autocomplete="new-password" autocapitalize="none" spellcheck="false" data-1p-ignore data-lpignore="true"><button class="icon-button" type="button" :title="showApiKey ? '隐藏 API Key' : '显示 API Key'" :disabled="credentialsLoading" @click="showApiKey = !showApiKey"><IconEyeOff v-if="showApiKey" :size="16" /><IconEye v-else :size="16" /></button></span><button type="button" class="button button--secondary button--small" :disabled="credentialsLoading || discovering || !form.baseUrl || !form.apiKey" @click="discoverModels"><IconCloudDownload :size="15" />{{ discovering ? '获取中' : '获取模型' }}</button></span></label>
      <section v-if="form.platformType === 'newapi'" class="form-section relay-checkin"><header><div><h3>NewAPI 控制台</h3><span>余额与签到</span></div><label class="switch"><input v-model="form.checkinEnabled" type="checkbox"><span />启用签到</label></header><div class="form-grid"><label for="relay-console-token"><span>控制台访问令牌 *</span><span class="relay-secret-input"><input id="relay-console-token" v-model="form.checkinToken" name="relay_console_token" :type="showCheckinToken ? 'text' : 'password'" :disabled="credentialsLoading" :placeholder="credentialsLoading ? '正在读取凭据…' : 'NewAPI access token'" required autocomplete="new-password" autocapitalize="none" spellcheck="false" data-1p-ignore data-lpignore="true"><button class="icon-button" type="button" :title="showCheckinToken ? '隐藏令牌' : '显示令牌'" :disabled="credentialsLoading" @click="showCheckinToken = !showCheckinToken"><IconEyeOff v-if="showCheckinToken" :size="16" /><IconEye v-else :size="16" /></button></span></label><label for="relay-console-account-reference"><span>用户 ID（可选）</span><input id="relay-console-account-reference" v-model="form.checkinUserId" name="relay_console_account_reference" :disabled="credentialsLoading" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="用于 New-Api-User"></label></div></section>
      <section class="form-section"><header><div><h3>模型品类</h3><span>{{ form.providerPresetId ? '官方服务已按产品能力固定品类' : '只声明站点提供哪些模型，协议和认证由保存后的检测自动识别' }}</span></div></header><div v-if="!form.providerPresetId" class="protocol-picker"><button v-for="option in scopeOptions" :key="option.id" type="button" class="protocol-option scope-option" :class="{ active: form.modelScopes.includes(option.id) }" @click="toggleScope(option.id)"><IconCheck :size="15" /><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button></div><div v-else class="relay-model-badges"><span v-for="scope in form.modelScopes" :key="scope">{{ scope === 'gpt' ? 'GPT' : scope === 'claude' ? 'Claude' : '其他厂商' }}</span></div></section>
      <section class="form-section relay-compat-settings"><header><div><h3>兼容设置</h3><span>模型只在你点击获取或同步时更新</span></div></header><label class="switch"><input v-model="form.clientIdentityMode" type="checkbox" true-value="passthrough" false-value="standard"><span />透传真实 Claude Code / Codex 客户端身份</label></section>
      <section v-if="discoveredModels.length" class="form-section relay-discovered"><header><div><h3>已获取模型</h3><span>{{ discoveredModels.length }} 个模型将直接启用</span></div><button type="button" class="button button--quiet button--small" @click="discoveredModels = []">清空</button></header><div class="relay-model-badges"><span v-for="model in discoveredModels" :key="model" :title="model">{{ model }}</span></div></section>
      <section class="form-section relay-mappings"><header><button type="button" class="relay-section-toggle" :aria-expanded="mappingsExpanded" @click="mappingsExpanded = !mappingsExpanded"><component :is="mappingsExpanded ? IconChevronUp : IconChevronDown" :size="16" /><span><strong>模型映射</strong><small>仅在需要修改 Hub 对外模型名或协议绑定时配置</small></span></button><button v-if="mappingsExpanded" type="button" class="button button--quiet button--small" @click="addModel"><IconPlus :size="15" />添加映射</button></header><div v-if="mappingsExpanded" class="relay-model-list"><div v-for="(model, index) in form.models" :key="model.id || index" class="relay-model-entry"><div class="relay-model-row"><input v-model="model.publicModel" placeholder="Hub 模型名（留空自动同名）"><span>→</span><input v-model="model.upstreamModel" placeholder="上游模型名"><button type="button" class="icon-button danger" title="移除模型" aria-label="移除模型" @click="removeModel(index)"><IconX :size="15" /></button></div><div class="relay-model-protocols"><button v-for="protocol in form.protocols" :key="protocol.protocol" type="button" :class="{ active: modelProtocolEnabled(model, protocol.protocol) }" @click="toggleModelProtocol(model, protocol.protocol)"><IconCheck :size="12" />{{ protocolLabel(protocol.protocol) }}</button></div></div></div></section>
      <div class="form-grid relay-settings-grid"><label><span>权重</span><input v-model.number="form.weight" type="number" min="1"></label><label><span>最大并发</span><input v-model.number="form.maxConcurrency" type="number" min="1"></label><label><span>超时（毫秒）</span><input v-model.number="form.timeoutMs" type="number" min="1000"></label></div>
      <p v-if="error" class="form-error">{{ error }}</p><footer><label class="switch"><input v-model="form.enabled" type="checkbox"><span />启用中转</label><div><button type="button" class="button button--secondary" @click="showForm = false">取消</button><button class="button button--primary" :disabled="busy || credentialsLoading">{{ credentialsLoading ? '读取凭据中' : busy ? '保存中' : '保存中转' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer v-if="editingGroup" :open="Boolean(editingGroup)" kicker="RELAY GROUP" :title="`设置 ${editingGroup.name}`" @close="editingGroup = null"><form class="admin-form" @submit.prevent="saveGroup">
      <div class="form-grid"><label><span>站点名称 *</span><input v-model="groupForm.name" required></label><label><span>平台 *</span><AppSelect v-model="groupForm.platformType"><option value="generic">通用兼容站</option><option value="newapi">NewAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
      <label><span>站点官网</span><input v-model="groupForm.homepageUrl" type="url" placeholder="https://relay.example.com"></label>
      <div class="form-grid"><label><span>账号排序</span><AppSelect v-model="groupForm.accountOrderMode"><option value="manual">手工顺序</option><option value="balance_desc">余额从高到低</option><option value="balance_asc">余额从低到高</option></AppSelect></label><label><span>站点总并发</span><input v-model.number="groupForm.maxConcurrency" type="number" min="1" placeholder="不限制"></label></div>
      <section v-if="(data?.groups.length || 0) > 1" class="form-section relay-group-move"><header><div><h3>账号归组</h3><span>单独移动账号，或把当前站点整体合并到其他站点</span></div></header><div v-for="account in editingGroup.accounts" :key="account.id"><span><strong>{{ account.accountLabel || account.name }}</strong><small>{{ account.baseUrl }}</small></span><AppSelect :model-value="''" :disabled="movingAccount === account.id" aria-label="移动账号到其他站点" @update:model-value="moveAccountToGroup(account, $event)"><option value="">移动到…</option><option v-for="target in data?.groups.filter(group => group.id !== editingGroup?.id) || []" :key="target.id" :value="target.id">{{ target.name }}</option></AppSelect></div><footer><AppSelect v-model="mergeTargetId" aria-label="合并目标站点"><option value="">选择合并目标…</option><option v-for="target in data?.groups.filter(group => group.id !== editingGroup?.id) || []" :key="target.id" :value="target.id">{{ target.name }}</option></AppSelect><button type="button" class="button button--secondary button--small" :disabled="!mergeTargetId || busy" @click="mergeGroup">合并当前站点</button></footer></section>
      <p v-if="groupError" class="form-error">{{ groupError }}</p><footer><button type="button" class="button button--danger" @click="deletingGroup = editingGroup; editingGroup = null"><IconTrash :size="15" />删除站点</button><div><label class="switch"><input v-model="groupForm.enabled" type="checkbox"><span />启用站点</label><button type="button" class="button button--secondary" @click="editingGroup = null">取消</button><button class="button button--primary" :disabled="busy">{{ busy ? '保存中' : '保存设置' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer v-if="duplicating" :open="Boolean(duplicating)" kicker="DUPLICATE RELAY" :title="`复制 ${duplicating.name}`" @close="duplicating = null; duplicateForm.apiKey = ''; duplicateForm.checkinToken = ''"><form class="admin-form" autocomplete="off" @submit.prevent="duplicateRelay">
      <div class="relay-copy-target" role="radiogroup" aria-label="复制目标"><label :class="{ active: !duplicateForm.newGroup }"><input v-model="duplicateForm.newGroup" type="radio" :value="false"><span><strong>当前站点的新账号</strong><small>保留在同一个故障转移节点内</small></span></label><label :class="{ active: duplicateForm.newGroup }"><input v-model="duplicateForm.newGroup" type="radio" :value="true"><span><strong>新的站点组</strong><small>创建独立的故障转移节点</small></span></label></div>
      <div v-if="duplicateForm.newGroup" class="form-grid"><label><span>新站点名称 *</span><input v-model="duplicateForm.groupName" required></label><label><span>平台 *</span><AppSelect v-model="duplicateForm.platformType"><option value="generic">通用兼容站</option><option value="newapi">NewAPI</option><option value="sub2api">Sub2API</option></AppSelect></label></div>
      <label v-if="duplicateForm.newGroup"><span>站点官网</span><input v-model="duplicateForm.homepageUrl" type="url"></label>
      <div class="form-grid"><label><span>账号名称 *</span><input v-model="duplicateForm.name" required></label><label><span>账号标签</span><input v-model="duplicateForm.accountLabel"></label></div>
      <label for="relay-copy-origin"><span>Base URL *</span><input id="relay-copy-origin" v-model="duplicateForm.baseUrl" name="relay_copy_origin" type="url" required autocomplete="url" autocapitalize="none" spellcheck="false"></label>
      <label for="relay-copy-token"><span>上游 API Key *</span><span class="relay-secret-input"><input id="relay-copy-token" v-model="duplicateForm.apiKey" name="relay_copy_token" :type="showDuplicateApiKey ? 'text' : 'password'" required autocomplete="new-password" autocapitalize="none" spellcheck="false" data-1p-ignore data-lpignore="true"><button class="icon-button" type="button" :title="showDuplicateApiKey ? '隐藏 API Key' : '显示 API Key'" :aria-label="showDuplicateApiKey ? '隐藏 API Key' : '显示 API Key'" @click="showDuplicateApiKey = !showDuplicateApiKey"><IconEyeOff v-if="showDuplicateApiKey" :size="16" /><IconEye v-else :size="16" /></button></span></label>
      <template v-if="duplicateForm.platformType === 'newapi'"><label for="relay-copy-console-token"><span>控制台访问令牌 *</span><span class="relay-secret-input"><input id="relay-copy-console-token" v-model="duplicateForm.checkinToken" name="relay_copy_console_token" :type="showDuplicateCheckinToken ? 'text' : 'password'" required autocomplete="new-password" autocapitalize="none" spellcheck="false" data-1p-ignore data-lpignore="true"><button class="icon-button" type="button" :title="showDuplicateCheckinToken ? '隐藏令牌' : '显示令牌'" :aria-label="showDuplicateCheckinToken ? '隐藏令牌' : '显示令牌'" @click="showDuplicateCheckinToken = !showDuplicateCheckinToken"><IconEyeOff v-if="showDuplicateCheckinToken" :size="16" /><IconEye v-else :size="16" /></button></span></label><label for="relay-copy-console-account-reference"><span>用户 ID</span><input id="relay-copy-console-account-reference" v-model="duplicateForm.checkinUserId" name="relay_copy_console_account_reference" autocomplete="off" autocapitalize="none" spellcheck="false"></label></template>
      <p v-if="duplicateLoading" class="form-note">正在读取原账号凭据…</p><p v-if="duplicateError" class="form-error">{{ duplicateError }}</p><footer><label class="switch"><input v-model="duplicateForm.enabled" type="checkbox"><span />启用副本</label><div><button type="button" class="button button--secondary" @click="duplicating = null">取消</button><button class="button button--primary" :disabled="busy || duplicateLoading">{{ busy ? '复制中' : '确认复制' }}</button></div></footer>
    </form></AppDrawer>

    <AppDrawer :open="routingOpen" wide kicker="MODEL ROUTING" title="模型路由与 CodexRadar" @close="routingOpen = false"><div class="route-settings">
      <section class="form-section"><header><div><h3>CodexRadar 推理强度</h3><span>只作用于原生或确认别名的 GPT 模型，不改变模型、来源和跨模型授权</span></div><label class="switch"><input v-model="radarForm.enabled" type="checkbox"><span />自动选择</label></header><div class="form-grid"><label><span>允许的最高档位</span><AppSelect v-model="radarForm.maxEffort"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="ultra">Ultra</option><option value="max">Max</option></AppSelect></label><label><span>雷达状态</span><div class="route-radar-summary">{{ radarData?.models.length || 0 }} 个评分 · {{ date(radarData?.updatedAt || null) }}</div></label></div></section>
      <section class="form-section route-policy-section"><header><div><h3>按请求模型设置故障转移</h3><span>默认只换资源、不换模型；替代模型必须逐项开启并排序</span></div><button type="button" class="button button--quiet button--small" @click="addRoutePolicy"><IconPlus :size="15" />添加模型</button></header>
        <div v-if="routePolicies.length" class="route-policy-list"><article v-for="(policy, policyIndex) in routePolicies" :key="policyIndex" class="route-policy"><header><label><span>请求模型</span><input v-model="policy.requestedModel" list="relay-routing-models" placeholder="例如 gpt-5.6-sol" @change="ensurePolicyLane(policy, policy.requestedModel)"></label><label class="switch"><input v-model="policy.substitutionEnabled" type="checkbox"><span />允许跨模型替代</label><button type="button" class="icon-button danger" title="删除策略" @click="routePolicies.splice(policyIndex, 1)"><IconTrash :size="15" /></button></header>
          <div v-if="policy.substitutionEnabled" class="route-substitutes"><label><span>添加替代模型</span><span class="relay-key-input"><input v-model="policy.newSubstitute" list="relay-routing-models" placeholder="选择或输入模型"><button type="button" class="button button--secondary button--small" @click="addSubstitute(policy)">添加</button></span></label><div class="route-chip-list"><button v-for="model in policy.substitutes" :key="model" type="button" draggable="true" title="拖拽调整替代顺序" @dragstart="draggedSubstitute = { policy: policyIndex, model }" @dragover.prevent @drop="dropSubstitute(policyIndex, model)"><IconGripVertical :size="13" />{{ model }}<IconX :size="12" @click.stop="policy.substitutes.splice(policy.substitutes.indexOf(model), 1)" /></button></div></div>
          <div v-for="model in policyModels(policy)" :key="model" class="route-lane"><header><strong>{{ model }}</strong><AppSelect v-model="policy.modes[model]" @update:model-value="ensurePolicyLane(policy, model)"><option value="manual">手工来源顺序</option><option value="price_asc">价格升序</option></AppSelect></header><div class="route-source-list"><button v-for="sourceId in policy.sourceOrders[model] || []" :key="sourceId" type="button" draggable="true" title="拖拽调整此模型的来源顺序" @dragstart="draggedSource = { policy: policyIndex, model, sourceId }" @dragover.prevent @drop="dropSource(policyIndex, model, sourceId)"><IconGripVertical :size="13" />{{ sourceName(sourceId) }}</button></div></div>
        </article></div><div v-else class="admin-empty">尚未设置模型专属策略，所有请求按全局故障转移顺序且只使用同名模型。</div>
      </section>
      <datalist id="relay-routing-models"><option v-for="model in routingData?.models || []" :key="model" :value="model" /></datalist>
      <footer class="route-settings-footer"><button class="button button--secondary" @click="routingOpen = false">取消</button><button class="button button--primary" :disabled="routingSaving" @click="saveRouting">{{ routingSaving ? '保存中' : '保存路由设置' }}</button></footer>
    </div></AppDrawer>
    <AppDrawer v-if="configuring" :open="Boolean(configuring)" kicker="CLIENT SETUP" :title="`连接 ${configuring.name}`" @close="configuring = null"><div class="config-builder">
      <div class="config-tabs"><button :class="{ active: configMode === 'claude' }" :disabled="!configuring.protocols.some(item => item.protocol === 'anthropic_messages' || item.protocol === 'openai_chat')" @click="configMode = 'claude'">Claude Code</button><button :class="{ active: configMode === 'codex' }" :disabled="!configuring.protocols.some(item => item.protocol === 'openai_responses' || item.protocol === 'openai_chat')" @click="configMode = 'codex'">Codex</button></div>
      <label><span>模型</span><AppSelect v-model="configModel"><option v-for="model in configuring.models.filter(item => item.enabled)" :key="model.id || model.publicModel" :value="model.publicModel">{{ model.publicModel }}</option></AppSelect></label>
      <div class="key-choice"><label><span>Hub Key</span><AppSelect v-model="selectedKeyId"><option value="new">新建专用 Key</option><option v-for="key in keyData?.keys.filter(item => item.status === 'active') || []" :key="key.id" :value="key.id">{{ key.name }} · {{ key.maskedKey }}</option></AppSelect></label></div>
      <div class="key-provision"><div><IconKey :size="18" /><span><strong>专用 Hub Key</strong><small>按故障转移顺序使用所有支持该模型的私有中转。</small></span></div><button class="button button--secondary button--small" :disabled="busy || !configModel" @click="useExistingKey">{{ generatedKey ? '重新绑定' : selectedKeyId === 'new' ? '生成专用 Key' : '绑定并读取 Key' }}</button></div>
      <pre><code>{{ configText }}</code></pre><button class="button button--primary" :disabled="!configText" @click="copyConfig"><IconCopy :size="16" />复制配置</button><p v-if="error" class="form-error">{{ error }}</p>
    </div></AppDrawer>
    <AppDrawer v-if="modelRelay" :open="Boolean(modelRelay)" wide kicker="RELAY MODELS" :title="`${modelRelay.name} · 模型`" @close="modelRelay = null"><section class="relay-model-drawer"><header><div><strong>{{ modelRelay.baseUrl }}</strong><small>{{ modelRelay.models.length }} 个模型 · {{ modelRelay.models.filter(model => model.enabled).length }} 个已启用</small></div><a class="button button--quiet button--small" :href="modelRelay.baseUrl" target="_blank" rel="noopener noreferrer"><IconExternalLink :size="14" />打开官网</a></header><div v-if="modelRelay.models.length" class="relay-model-catalog"><article v-for="model in modelRelay.models" :key="model.id || model.publicModel" :data-disabled="!model.enabled"><div><strong>{{ model.publicModel }}</strong><small v-if="model.upstreamModel !== model.publicModel">上游：{{ model.upstreamModel }}</small><small>{{ model.vendorFamily || 'other' }}<template v-if="model.price"> · 输入 {{ model.price.inputPerMillion ?? '?' }} / 输出 {{ model.price.outputPerMillion ?? '?' }} {{ model.price.currency }}/M</template></small></div><div class="relay-model-meta"><span>{{ model.enabled ? '已启用' : '已停用' }}</span><code>{{ model.endpoints.length ? model.endpoints.map(endpoint => endpoint.replace('/v1/', '')).join(' · ') : '按协议支持' }}</code><button class="button button--quiet button--small" :disabled="Boolean(modelTesting) || !model.enabled" @click="testRelayModel(modelRelay, model.upstreamModel)"><IconRefresh :class="{ 'is-spinning': modelTesting === model.upstreamModel }" :size="13" />测试</button></div></article></div><div v-else class="admin-empty">该中转暂无模型</div></section></AppDrawer>
    <AppConfirmDialog :open="Boolean(testingCandidate)" title="执行协议检测" :message="`将先读取“${testingCandidate?.name || ''}”的模型，再按品类自动测试 Responses、Chat 或 Messages；认证失败时自动补测另一种认证，上游可能计费。`" confirm-label="开始检测" confirm-tone="primary" busy-label="检测中" :busy="Boolean(testing)" @close="testingCandidate = null" @confirm="confirmTest" />
    <AppDrawer v-if="testReport" :open="Boolean(testReport)" kicker="PROTOCOL DIAGNOSTICS" :title="testReport.relayName" @close="testReport = null"><div class="relay-test-results"><article class="relay-connectivity-result" :data-ok="testReport.connectivity.ok"><div><strong>基础连接 · /v1/models</strong><span>{{ testReport.connectivity.ok ? '可达' : testReport.connectivity.reachable ? '接口异常' : '连接失败' }} · {{ testReport.connectivity.latencyMs }} ms</span></div><code>{{ testReport.connectivity.endpoint }}</code><small>{{ testReport.connectivity.modelCount }} 个模型 · {{ testReport.connectivity.clientIdentityProbed ? '已使用兼容客户端身份重试' : '标准服务端身份' }} · 检测成功后同步模型目录与能力绑定</small><p v-if="testReport.connectivity.errorCode || testReport.connectivity.message"><b v-if="testReport.connectivity.errorCode">{{ testReport.connectivity.errorCode }}</b>{{ testReport.connectivity.message }}</p></article><article v-for="result in testReport.results" :key="result.protocol" :data-ok="result.ok"><div><strong>{{ protocolLabel(result.protocol) }}</strong><span>{{ result.ok ? '通过' : result.clientIdentityRejected ? '等待真实客户端' : '失败' }} · {{ result.latencyMs }} ms</span></div><code>{{ result.endpoint }}</code><small>采用 {{ result.authScheme === 'bearer' ? 'Bearer' : 'x-api-key' }}<template v-if="result.attemptedAuthSchemes.length > 1"> · 已自动测试 Bearer 与 x-api-key</template><template v-if="result.clientIdentityProbed"> · 使用兼容客户端身份</template></small><p v-if="result.clientIdentityRejected">上游仍拒绝兼容客户端身份，请使用真实 Claude Code / Codex 请求完成验证。</p><p v-else-if="result.errorCode || result.message"><b v-if="result.errorCode">{{ result.errorCode }}</b>{{ result.message }}</p></article></div></AppDrawer>
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
.relay-group-list { margin-bottom:1rem; display:grid; gap:.75rem; }
.relay-group-summary { overflow:hidden; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface); }
.relay-group-summary > header { min-height:58px; padding:.65rem .8rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--line-subtle); }
.relay-group-summary > header > div:first-child { min-width:0; display:grid; gap:.18rem; }
.relay-group-summary > header strong { font-size:.84rem; }
.relay-group-summary > header strong a { display:inline-flex; align-items:center; gap:.3rem; color:inherit; text-decoration:none; }
.relay-group-summary > header strong a:hover { color:var(--accent); }
.relay-group-summary > header small { color:var(--text-muted); font-size:.67rem; }
.relay-group-actions { display:flex; align-items:center; gap:.35rem; }
.relay-group-actions select { min-width:120px; }
.relay-account-list { display:grid; }
.relay-row { min-height:88px; display:grid; grid-template-columns:minmax(220px,1.15fr) minmax(180px,.8fr) minmax(150px,.75fr) auto; gap:1rem; align-items:center; padding:.85rem 1rem; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface); }
.relay-account-list > .relay-row { border-width:1px 0 0; border-radius:0; }
.relay-account-list > .relay-row:first-child { border-top:0; }
.relay-row.is-draggable { grid-template-columns:32px minmax(220px,1.15fr) minmax(180px,.8fr) minmax(150px,.75fr) auto; }
.relay-row.is-dragging { opacity:.45; background:var(--surface-soft); }
.relay-row-drag { align-self:stretch; display:grid; place-items:center; align-content:center; gap:.3rem; padding:0; border:0; background:transparent; color:var(--text-muted); cursor:grab; touch-action:none; }
.relay-row-drag:active { cursor:grabbing; }
.relay-row-drag span { font:700 .62rem/1 var(--font-mono); }
.relay-balance { min-width:0; display:grid; gap:.2rem; }
.relay-balance strong { color:var(--hub-accent); font-family:var(--font-mono); font-size:.86rem; }
.relay-balance small { overflow:hidden; color:var(--hub-text-faint); font-size:.64rem; text-overflow:ellipsis; white-space:nowrap; }
.relay-identity { min-width:0; display:flex; align-items:center; gap:.75rem; }
.relay-identity > span { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--line-strong); color:var(--accent); background:var(--surface-soft); }
.relay-identity > div { min-width:0; display:grid; gap:.2rem; }
.relay-identity code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); font-size:.72rem; }
.relay-url { min-width:0; display:flex; align-items:center; gap:.25rem; overflow:hidden; color:var(--accent); font: .72rem/1.3 var(--font-mono); text-decoration:none; text-overflow:ellipsis; white-space:nowrap; }
.relay-url:hover { text-decoration:underline; }
.relay-identity small { color:var(--text-muted); font-size:.72rem; }
.relay-capability-line { min-width:0; overflow:hidden; color:var(--text-muted); font-size:.68rem; line-height:1.45; text-overflow:ellipsis; white-space:nowrap; }
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
.scope-option { min-height:64px; padding:.65rem; display:flex; align-items:center; gap:.55rem; text-align:left; color:var(--text); }
.scope-option > svg { flex:none; opacity:0; }
.scope-option.active > svg { opacity:1; color:var(--accent); }
.scope-option > span { display:grid; gap:.15rem; }
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
.route-settings { display:grid; gap:1rem; padding:.2rem; }
.route-settings .form-section { margin:0; }
.route-radar-summary { min-height:42px; padding:0 .7rem; display:flex; align-items:center; border:1px solid var(--line-strong); color:var(--text-muted); font-size:.72rem; }
.route-policy-list { display:grid; gap:.75rem; }
.route-policy { display:grid; gap:.8rem; padding:.8rem; border:1px solid var(--line-subtle); background:var(--surface); }
.route-policy > header { display:grid; grid-template-columns:minmax(220px,1fr) auto auto; align-items:end; gap:.75rem; }
.route-policy > header > label:first-child,.route-substitutes > label { display:grid; gap:.35rem; color:var(--text-muted); font-size:.7rem; }
.route-substitutes { display:grid; gap:.5rem; padding-top:.7rem; border-top:1px solid var(--line-subtle); }
.route-chip-list,.route-source-list { display:flex; flex-wrap:wrap; gap:.35rem; }
.route-chip-list button,.route-source-list button { min-height:30px; padding:0 .5rem; display:inline-flex; align-items:center; gap:.35rem; border:1px solid var(--line-strong); border-radius:3px; color:var(--text-muted); background:var(--surface-soft); font-size:.67rem; cursor:grab; }
.route-lane { display:grid; gap:.5rem; padding:.65rem; border-left:2px solid var(--accent); background:var(--surface-soft); }
.route-lane > header { display:flex; align-items:center; justify-content:space-between; gap:.75rem; }
.route-lane > header strong { font:700 .72rem/1.3 var(--font-mono); }
.route-lane .app-select { width:170px; }
.route-settings-footer { display:flex; justify-content:flex-end; gap:.5rem; }
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
@media (max-width:900px) { .relay-row { grid-template-columns:1fr auto; } .relay-row.is-draggable { grid-template-columns:32px 1fr auto; } .relay-capability-line,.relay-balance { grid-column:1 / -1; } .relay-row.is-draggable .relay-capability-line,.relay-row.is-draggable .relay-balance { grid-column:2 / -1; } }
@media (max-width:640px) { .resource-panel-header { align-items:stretch; flex-direction:column; } .resource-panel-actions { width:100%; flex-wrap:wrap; } .resource-panel-actions .button { flex:1 1 auto; } .relay-group-summary > header { align-items:flex-start; flex-direction:column; } .relay-group-actions { width:100%; flex-wrap:wrap; } .relay-group-actions .app-select { flex:1 1 150px; } .protocol-picker,.key-choice,.relay-settings-grid,.relay-key-input,.relay-copy-target { grid-template-columns:1fr; } .relay-row,.relay-row.is-draggable { grid-template-columns:1fr; } .relay-row-drag { grid-template-columns:auto auto; justify-content:start; padding:.15rem 0; } .relay-row.is-draggable .relay-capability-line,.relay-row.is-draggable .relay-balance { grid-column:1; } .relay-row > .table-actions { justify-content:flex-end; flex-wrap:wrap; } .relay-model-row { grid-template-columns:1fr auto; } .relay-model-row > span { display:none; } .key-provision { align-items:flex-start; flex-direction:column; } .relay-model-catalog article { align-items:flex-start; flex-direction:column; gap:.45rem; } .relay-model-meta { justify-items:start; text-align:left; } .relay-model-meta code { max-width:100%; } .route-policy > header { grid-template-columns:1fr auto; } .route-policy > header > label:first-child { grid-column:1 / -1; } .route-lane > header { align-items:stretch; flex-direction:column; } .route-lane .app-select { width:100%; } }
</style>
