<script setup lang="ts">
import { IconArrowDown, IconArrowUp, IconCircleCheck, IconCloudUpload, IconCopy, IconDeviceMobile, IconEdit, IconExternalLink, IconFileCode, IconLogin2, IconMessageCode, IconPlayerPlay, IconPlus, IconRefresh, IconSearch, IconShieldLock, IconTrash } from '@tabler/icons-vue'
import {
  ACCOUNT_DELIVERY_FIELDS,
  ACCOUNT_VAULT_STATUSES,
  ACCOUNT_VAULT_SOURCES,
  type AccountDeliveryField,
  type AccountVaultSource,
  type AccountVaultStatus,
  type AccountVaultView,
  type SmsCodeResult,
  type SmsReceiverImportResult,
  type SmsReceiverView
} from '#shared/types/accounting'
import { convertCredentialDocuments, parseCredentialSourceText, type CredentialSourceDocument } from '#shared/utils/credential-converter'

interface Pool { id: string; displayName: string; status: string; maxAccounts: number | null; accountCount: number; availableAccountCount: number; lastError: string | null }
interface Account { id: string; displayName: string; email: string | null; platform: string; accountType: string; status: string; schedulable: boolean; source: string; lastVerifiedAt: number | null; lastError: string | null; createdAt?: number; updatedAt?: number }
interface ImportRow { key: string; name: string; email: string | null; notes: string | null; platform: string; type: string; credentials: Record<string, unknown>; extra: Record<string, unknown>; concurrency: number; priority: number; rateMultiplier: number; expiresAt: number | null; autoPauseOnExpired: boolean; source: string }
interface OAuthForm { name: string; authorizationUrl: string; flowId: string; callbackUrl: string; expiresAt: number | null }
type PageTab = 'accounts' | 'receivers'
type ImportMode = 'manual' | 'upload' | 'batch' | 'convert'

const { data, refresh, status: poolStatus } = useLazyFetch<{ pool: Pool | null; accounts: Account[] }>('/api/console/pool')
const { data: receiverData, refresh: refreshReceivers } = useLazyFetch<{ items: SmsReceiverView[] }>('/api/console/pool/sms-receivers')
const { data: vaultData, refresh: refreshVault } = useLazyFetch<{ items: AccountVaultView[] }>('/api/console/pool/account-vault')
const { data: usageData, refresh: refreshUsage } = useLazyFetch<{ items: Array<{ accountId: string; quotaStatus: string; planType: string | null; windows: Array<{ label: string; remainingPercent: number | null; remaining: number | null; resetAt: number | null }>; error?: string }>; generatedAt: number }>('/api/console/pool/usage')
const { data: planData } = useLazyFetch<{ subscription: null | { status: string; plan: { entitlementSnapshot?: Record<string, unknown>; version?: { supplyMode?: string; maxPoolAccounts?: number | null } | null } } }>('/api/console/plan')
const authSession = useState<{ user?: { role?: string } } | null>('auth-session', () => null)
const toast = useAppToast()
const provisioning = ref(false)
const saving = ref(false)
const loading = ref(false)
const verifying = ref<string | null>(null)
const deleting = ref<Account | null>(null)
const editing = ref<Account | null>(null)
const drawer = ref<'import' | 'oauth' | 'edit' | 'receiver' | null>(null)
const activeTab = ref<PageTab>('accounts')
const importMode = ref<ImportMode>('manual')
const search = ref('')
const importText = ref('')
const credentialFileName = ref('')
const showCredentialPaste = ref(false)
const importRows = ref<ImportRow[]>([])
const importNotice = ref('')
const error = ref('')
const oauthError = ref('')
const oauth = reactive<OAuthForm>({ name: '', authorizationUrl: '', flowId: '', callbackUrl: '', expiresAt: null })
const editForm = reactive({ displayName: '', schedulable: false })
const editReceiverId = ref('')
const receiverCreateMode = ref<'single' | 'batch'>('single')
const editingReceiver = ref<SmsReceiverView | null>(null)
const receiverImportText = ref('')
const receiverError = ref('')
const receiverBusy = ref(false)
const receiverCodes = reactive<Record<string, SmsCodeResult | undefined>>({})
const accountCodes = reactive<Record<string, SmsCodeResult | undefined>>({})
const receiverForm = reactive({ phone: '', fetchUrl: '', note: '', active: true })
const manualForm = reactive({ email: '', displayName: '', source: '' as AccountVaultSource | '', status: 'Codex' as AccountVaultStatus, password: '', emailCodeUrl: '', totpSecret: '', smsReceiverId: '', remark: '' })
const deliveryText = ref('')
const deliveryFields = ref<AccountDeliveryField[]>(['email', 'password'])
const deliverySource = ref<AccountVaultSource | ''>('')
const deliveryError = ref('')

const pool = computed(() => data.value?.pool || null)
const accounts = computed(() => data.value?.accounts || [])
const accountUsage = computed(() => new Map((usageData.value?.items || []).map(item => [item.accountId, item])))
const vaultAccounts = computed(() => vaultData.value?.items || [])
const filteredAccounts = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return accounts.value
  return accounts.value.filter(item => `${item.displayName} ${item.email || ''} ${item.platform} ${item.accountType} ${item.source}`.toLowerCase().includes(query))
})
const poolEntitlement = computed(() => {
  if (['admin', 'super_admin'].includes(authSession.value?.user?.role || '')) return { allowed: true, maxAccounts: null }
  const subscription = planData.value?.subscription
  const snapshot = subscription?.plan.entitlementSnapshot || {}
  const version = subscription?.plan.version || null
  return { allowed: subscription?.status === 'active', maxAccounts: Number(snapshot.maxPoolAccounts ?? version?.maxPoolAccounts) || null }
})
const importReady = computed(() => importRows.value.length > 0)
const receivers = computed(() => receiverData.value?.items || [])
const receiverForAccount = (accountId: string) => receivers.value.find(item => item.accounts.some(account => account.id === accountId)) || null
const receiverSummary = computed(() => ({ total: receivers.value.length, available: receivers.value.reduce((sum, item) => sum + item.availableSlots, 0) }))
const accountSourceLabels: Record<AccountVaultSource, string> = { ldxp: 'LDXP', nvtoken: 'NVToken', other: '其他', unknown: '未标注' }
const deliveryFieldLabels: Record<AccountDeliveryField, string> = { email: '账号', password: '密码', totpSecret: '2FA 密钥', emailCodeUrl: '验证码地址', accessToken: 'AT', refreshToken: 'RT' }
const deliveryFieldOptions = ACCOUNT_DELIVERY_FIELDS.map(value => ({ value, label: deliveryFieldLabels[value] }))
const deliveryConfigurationError = computed(() => {
  if (!deliveryFields.value.includes('email')) return '必须包含账号字段'
  if (deliveryFields.value.includes('accessToken') !== deliveryFields.value.includes('refreshToken')) return 'AT 和 RT 必须同时选择'
  return ''
})
const selectedDeliveryFormat = computed(() => ({ label: deliveryFields.value.map(field => deliveryFieldLabels[field]).join(' + '), placeholder: deliveryFields.value.map(field => deliveryFieldLabels[field]).join('----'), fields: deliveryFields.value.length }))
const deliveryPreview = computed(() => {
  if (deliveryConfigurationError.value) return []
  const selected = selectedDeliveryFormat.value
  return deliveryText.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const fields = line.split('----').map(field => field.trim())
    const values = Object.fromEntries(deliveryFields.value.map((field, fieldIndex) => [field, fields[fieldIndex] || ''])) as Record<AccountDeliveryField, string>
    const validEmail = /^\S+@\S+\.\S+$/.test(values.email || '')
    const validFields = fields.length === selected.fields && fields.every(Boolean)
    const validUrl = !deliveryFields.value.includes('emailCodeUrl') || /^https?:\/\//i.test(values.emailCodeUrl)
    const validTotp = !deliveryFields.value.includes('totpSecret') || /^[A-Z2-7\s=]+$/i.test(values.totpSecret)
    const valid = validEmail && validFields && validUrl && validTotp
    return { index, email: validEmail ? values.email : '账号格式错误', kind: valid ? selected.label : '格式错误', valid }
  })
})

function failureMessage(value: unknown, fallback: string) {
  const failure = value as { data?: { message?: string }; message?: string }
  return failure.data?.message || failure.message || fallback
}
async function provision() {
  provisioning.value = true
  error.value = ''
  try { await $fetch('/api/console/pool/provision', { method: 'POST' }); await refresh(); await refreshUsage() }
  catch (value) { error.value = failureMessage(value, '创建号池失败') }
  finally { provisioning.value = false }
}
async function refreshPool() {
  loading.value = true
  try { await Promise.all([refresh(), refreshUsage()]) } finally { loading.value = false }
}
function usageLabel(accountId: string) {
  const usage = accountUsage.value.get(accountId)
  if (!usage) return '未查询'
  if (usage.error && !usage.windows.length) return '查询失败'
  const window = usage.windows.find(item => item.remainingPercent !== null) || usage.windows[0]
  if (!window) return usage.quotaStatus === 'success' ? '无额度窗口' : '查询失败'
  return window.remainingPercent === null ? `${window.remaining ?? '—'} 剩余` : `${window.remainingPercent.toFixed(1)}% 剩余`
}
function usageDetail(accountId: string) {
  const usage = accountUsage.value.get(accountId)
  const window = usage?.windows.find(item => item.remainingPercent !== null) || usage?.windows[0]
  return window ? `${window.label}${window.resetAt ? ` · ${date(window.resetAt)} 重置` : ''}` : '点击刷新用量'
}
function usageWindows(accountId: string) { return accountUsage.value.get(accountId)?.windows || [] }
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function jwtClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  const payload = value.split('.')[1]
  if (!payload) return {}
  try { return objectValue(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))) || {} } catch { return {} }
}
function credentialIdentity(credentials: Record<string, unknown>) {
  const idClaims = jwtClaims(credentials.id_token)
  const accessClaims = jwtClaims(credentials.access_token)
  const profile = objectValue(accessClaims['https://api.openai.com/profile']) || {}
  return {
    email: String(credentials.email || idClaims.email || profile.email || '').trim() || null,
    name: String(credentials.name || idClaims.name || profile.name || '').trim() || null
  }
}
function parseImportText(value: string) {
  error.value = ''
  importText.value = value
  let root: Record<string, unknown>
  try {
    const parsed = JSON.parse(value)
    root = objectValue(parsed) || (Array.isArray(parsed) ? { accounts: parsed } : {})
    if (!Object.keys(root).length) throw new Error('empty')
  } catch { importRows.value = []; error.value = '文件不是有效的 JSON 对象'; return }
  const sourceAccounts = Array.isArray(root.accounts) ? root.accounts : root.credentials && objectValue(root.credentials) ? [root] : [{ credentials: root }]
  importRows.value = sourceAccounts.map((value, index) => {
    const account = objectValue(value) || {}
    const credentials = objectValue(account.credentials) || (sourceAccounts.length === 1 ? root : {})
    const extra = objectValue(account.extra) || {}
    const identity = credentialIdentity(credentials)
    const email = String(account.email || extra.email || identity.email || '').trim() || null
    const name = String(account.name || account.displayName || extra.name || identity.name || email || `导入账号 ${index + 1}`).trim()
    const inferredType = credentials.refresh_token || credentials.access_token ? 'oauth' : 'apikey'
    return {
      key: `${index}:${name}`,
      name,
      email,
      notes: String(account.notes || '').trim() || null,
      platform: String(account.platform || 'openai'),
      type: String(account.type || inferredType),
      credentials,
      extra,
      concurrency: Number(account.concurrency) > 0 ? Number(account.concurrency) : 10,
      priority: Number(account.priority) >= 0 ? Number(account.priority) : 0,
      rateMultiplier: Number(account.rate_multiplier) >= 0 ? Number(account.rate_multiplier) : 1,
      expiresAt: Number(account.expires_at) > 0 ? Number(account.expires_at) * (Number(account.expires_at) < 1e12 ? 1000 : 1) : null,
      autoPauseOnExpired: account.auto_pause_on_expired !== false,
      source: String(account.source || 'import')
    }
  }).filter(row => Object.keys(row.credentials).length > 0)
  if (!importRows.value.length) error.value = 'JSON 中没有可导入的账号'
}
function parseConvertedDocuments(documents: CredentialSourceDocument[]) {
  error.value = ''
  const result = convertCredentialDocuments(documents)
  importRows.value = result.accounts.map((account, index) => ({
    key: account.key,
    name: account.name,
    email: account.email,
    notes: `由 ${account.sourceType} 转换导入`,
    platform: 'openai',
    type: 'oauth',
    credentials: account.sub2apiCredentials,
    extra: account.sub2apiExtra,
    concurrency: 10,
    priority: 0,
    rateMultiplier: 1,
    expiresAt: account.expiresAt,
    autoPauseOnExpired: true,
    source: 'conversion'
  }))
  importNotice.value = result.skipped.length ? `已跳过 ${result.skipped.length} 项：${result.skipped.slice(0, 3).map(item => item.message).join('；')}` : ''
  if (!importRows.value.length) error.value = importNotice.value || '没有识别到可导入的账号凭据'
}
async function credentialFile(event: Event) {
  const files = [...((event.target as HTMLInputElement).files || [])]
  if (!files.length) return
  credentialFileName.value = files.length === 1 ? files[0]!.name : `${files.length} 个 JSON 文件`
  showCredentialPaste.value = false
  if (importMode.value === 'convert') {
    try { parseConvertedDocuments(await Promise.all(files.map(async file => parseCredentialSourceText(await file.text(), file.name)))) }
    catch (value) { importRows.value = []; error.value = failureMessage(value, '凭据转换失败') }
  } else if (files[0]) parseImportText(await files[0].text())
}
function parsePastedCredentials() {
  credentialFileName.value = '粘贴的 JSON 内容'
  if (importMode.value === 'convert') {
    try { parseConvertedDocuments([parseCredentialSourceText(importText.value)]) }
    catch (value) { importRows.value = []; error.value = failureMessage(value, '凭据转换失败') }
  } else parseImportText(importText.value)
}
function resetImporter() {
  error.value = ''; importNotice.value = ''; importText.value = ''; credentialFileName.value = ''; showCredentialPaste.value = false; importRows.value = []
  deliveryText.value = ''; deliveryFields.value = ['email', 'password']; deliverySource.value = ''; deliveryError.value = ''
  Object.assign(manualForm, { email: '', displayName: '', source: '', status: 'Codex', password: '', emailCodeUrl: '', totpSecret: '', smsReceiverId: '', remark: '' })
}
function openImport(mode: ImportMode = 'manual') {
  resetImporter(); importMode.value = mode; drawer.value = 'import'
}
function switchImportMode(mode: ImportMode) {
  importMode.value = mode; error.value = ''; deliveryError.value = ''; importNotice.value = ''
}
function toggleDeliveryField(field: AccountDeliveryField) {
  if (field === 'email') return
  deliveryFields.value = deliveryFields.value.includes(field) ? deliveryFields.value.filter(item => item !== field) : [...deliveryFields.value, field]
  deliveryError.value = ''
}
function moveDeliveryField(field: AccountDeliveryField, offset: -1 | 1) {
  const current = [...deliveryFields.value]
  const index = current.indexOf(field)
  const target = index + offset
  if (index < 0 || target < 0 || target >= current.length) return
  ;[current[index], current[target]] = [current[target]!, current[index]!]
  deliveryFields.value = current
}
async function saveManualAccount() {
  saving.value = true; error.value = ''
  try {
    await $fetch('/api/console/pool/account-vault', { method: 'POST', body: { ...manualForm, smsReceiverId: manualForm.smsReceiverId || null } })
    await Promise.all([refreshVault(), refreshReceivers()])
    drawer.value = null
    toast.show('账号资料已创建', 'success')
  } catch (value) { error.value = failureMessage(value, '保存账号失败') } finally { saving.value = false }
}
async function importDelivery() {
  deliveryError.value = ''
  if (!deliverySource.value) { deliveryError.value = '请选择账号来源'; return }
  if (deliveryConfigurationError.value) { deliveryError.value = deliveryConfigurationError.value; return }
  if (!deliveryPreview.value.length) { deliveryError.value = '请输入发货内容'; return }
  saving.value = true
  try {
    const result = await $fetch<{ created: number; skipped: number; failed: Array<{ index: number; email: string; message: string }> }>('/api/console/pool/account-vault/delivery-import', { method: 'POST', body: { text: deliveryText.value, fields: deliveryFields.value, source: deliverySource.value } })
    await Promise.all([refreshVault(), refreshReceivers()])
    if (result.failed.length) {
      deliveryError.value = result.failed.slice(0, 5).map(item => `第 ${item.index + 1} 行${item.email ? `（${item.email}）` : ''}：${item.message}`).join('\n')
      toast.show(`导入完成：新增 ${result.created}，跳过 ${result.skipped}，失败 ${result.failed.length}`, 'error')
      return
    }
    drawer.value = null
    toast.show(`发货账号已导入：新增 ${result.created}，跳过 ${result.skipped}`, 'success')
  } catch (value) { deliveryError.value = failureMessage(value, '发货账号导入失败') } finally { saving.value = false }
}
async function submitImport() {
  if (importMode.value === 'manual') return saveManualAccount()
  if (importMode.value === 'batch') return importDelivery()
  return importAccounts()
}
async function importAccounts() {
  if (!importRows.value.length) parseImportText(importText.value)
  if (!importRows.value.length) return
  saving.value = true; error.value = ''
  try {
    const result = await $fetch<{ mode: 'accounts'; created: Account[]; failed: Array<{ name: string; error: string }> }>('/api/console/pool/accounts', { method: 'POST', body: { accounts: importRows.value.map(row => ({ ...row, displayName: row.name })) } })
    importNotice.value = `批量导入完成：成功 ${result.created?.length || 0}，失败 ${result.failed?.length || 0}`
    if (result.failed?.length) error.value = result.failed.map(item => `${item.name}：${item.error}`).join('；')
    await Promise.all([refresh(), refreshVault()])
    if (!result.failed?.length) drawer.value = null
    toast.show(importNotice.value, result.failed?.length ? 'error' : 'success')
  } catch (value) { error.value = failureMessage(value, '导入账号失败') } finally { saving.value = false }
}
function openOAuth() {
  Object.assign(oauth, { name: '', authorizationUrl: '', flowId: '', callbackUrl: '', expiresAt: null }); oauthError.value = ''; drawer.value = 'oauth'
}
async function startOAuth() {
  saving.value = true; oauthError.value = ''
  try {
    const result = await $fetch<{ authorizationUrl: string; flowId: string; expiresAt: number }>('/api/console/pool/oauth/start', { method: 'POST' })
    Object.assign(oauth, result)
  } catch (value) { oauthError.value = failureMessage(value, '生成授权链接失败') } finally { saving.value = false }
}
async function completeOAuth() {
  if (!oauth.flowId || !oauth.callbackUrl.trim()) { oauthError.value = '请粘贴 localhost 开头的完整回调 URL'; return }
  saving.value = true; oauthError.value = ''
  try {
    await $fetch('/api/console/pool/oauth/complete', { method: 'POST', body: { flowId: oauth.flowId, callbackUrl: oauth.callbackUrl, name: oauth.name } })
    drawer.value = null; await refresh(); toast.show('OpenAI 账号已授权并保持不可调度，请先验活', 'success')
  } catch (value) { oauthError.value = failureMessage(value, '完成 OpenAI 授权失败') } finally { saving.value = false }
}
function openEdit(account: Account) { editing.value = account; Object.assign(editForm, { displayName: account.displayName, schedulable: account.schedulable }); editReceiverId.value = receiverForAccount(account.id)?.id || ''; error.value = ''; drawer.value = 'edit' }
async function saveEdit() {
  if (!editing.value) return
  saving.value = true; error.value = ''
  try { await Promise.all([$fetch(`/api/console/pool/accounts/${editing.value.id}`, { method: 'PATCH', body: { displayName: editForm.displayName, schedulable: editForm.schedulable } }), $fetch(`/api/console/pool/accounts/${editing.value.id}/receiver`, { method: 'PUT', body: { receiverId: editReceiverId.value || null } })]); drawer.value = null; await Promise.all([refresh(), refreshReceivers()]); toast.show('账号配置已更新', 'success') }
  catch (value) { error.value = failureMessage(value, '保存账号失败') } finally { saving.value = false }
}
async function verify(account: Account, activate = false) {
  verifying.value = account.id; error.value = ''
  try { await $fetch(`/api/console/pool/accounts/${account.id}/verify`, { method: 'POST' }); if (activate) await $fetch(`/api/console/pool/accounts/${account.id}`, { method: 'PATCH', body: { schedulable: true } }); await refresh(); toast.show(activate ? '账号已验活并启用' : '账号验活完成', 'success') }
  catch (value) { toast.show(failureMessage(value, '账号验活失败'), 'error') } finally { verifying.value = null }
}
async function remove() {
  if (!deleting.value) return
  loading.value = true
  try { await $fetch(`/api/console/pool/accounts/${deleting.value.id}`, { method: 'DELETE' }); deleting.value = null; await refresh(); toast.show('账号已删除', 'success') }
  catch (value) { toast.show(failureMessage(value, '删除账号失败'), 'error') } finally { loading.value = false }
}
function openUrl() { if (oauth.authorizationUrl) window.open(oauth.authorizationUrl, '_blank', 'noopener,noreferrer') }
function selectOAuthUrl(event: Event) { (event.target as HTMLInputElement).select() }
async function copyUrl() { if (oauth.authorizationUrl) { await navigator.clipboard.writeText(oauth.authorizationUrl); toast.show('授权链接已复制', 'success') } }
function openReceiverCreate(item?: SmsReceiverView) {
  editingReceiver.value = item || null
  receiverCreateMode.value = 'single'
  receiverImportText.value = ''
  receiverError.value = ''
  Object.assign(receiverForm, { phone: item?.phone || '', fetchUrl: '', note: item?.note || '', active: item?.status !== 'disabled' })
  drawer.value = 'receiver'
}
async function saveReceiver() {
  receiverBusy.value = true; receiverError.value = ''
  try {
    if (!editingReceiver.value && receiverCreateMode.value === 'batch') {
      const result = await $fetch<SmsReceiverImportResult>('/api/console/pool/sms-receivers/import', { method: 'POST', body: { text: receiverImportText.value } })
      if (result.failed.length) receiverError.value = result.failed.slice(0, 5).map(item => `第 ${item.line} 行：${item.error}`).join('\n')
      toast.show(`接码导入：成功 ${result.created.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`, result.failed.length ? 'error' : 'success')
      if (!result.failed.length) drawer.value = null
    } else {
      const body = { phone: receiverForm.phone, note: receiverForm.note, status: receiverForm.active ? 'active' : 'disabled', ...(receiverForm.fetchUrl ? { fetchUrl: receiverForm.fetchUrl } : {}) }
      if (editingReceiver.value) await $fetch(`/api/console/pool/sms-receivers/${editingReceiver.value.id}`, { method: 'PATCH', body })
      else await $fetch('/api/console/pool/sms-receivers', { method: 'POST', body })
      drawer.value = null; toast.show('接码资源已保存', 'success')
    }
    await refreshReceivers()
  } catch (value) { receiverError.value = failureMessage(value, '保存接码资源失败') } finally { receiverBusy.value = false }
}
async function toggleReceiver(item: SmsReceiverView, active: boolean) {
  try { await $fetch(`/api/console/pool/sms-receivers/${item.id}`, { method: 'PATCH', body: { status: active ? 'active' : 'disabled' } }); await refreshReceivers() }
  catch (value) { toast.show(failureMessage(value, '更新接码状态失败'), 'error') }
}
async function refreshReceiverCode(item: SmsReceiverView) {
  try { const { result } = await $fetch<{ result: SmsCodeResult }>(`/api/console/pool/sms-receivers/${item.id}/refresh`, { method: 'POST' }); receiverCodes[item.id] = result; await refreshReceivers() }
  catch (value) { toast.show(failureMessage(value, '获取验证码失败'), 'error') }
}
async function refreshAccountCode(account: Account) {
  try { const { result } = await $fetch<{ result: SmsCodeResult }>(`/api/console/pool/accounts/${account.id}/sms/refresh`, { method: 'POST' }); accountCodes[account.id] = result; if (result.code) { await navigator.clipboard.writeText(result.code); toast.show('验证码已复制', 'success') } }
  catch (value) { toast.show(failureMessage(value, '获取验证码失败'), 'error') }
}
async function deleteReceiver(item: SmsReceiverView) {
  if (!confirm(`确定删除接码 ${item.phone}？`)) return
  try { await $fetch(`/api/console/pool/sms-receivers/${item.id}`, { method: 'DELETE' }); await refreshReceivers(); toast.show('接码资源已删除', 'success') }
  catch (value) { toast.show(failureMessage(value, '删除接码失败'), 'error') }
}
const date = (value: number | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value) : '尚未验活'
const sourceLabel = (value: string) => value === 'oauth' ? 'Auth 登录' : value === 'conversion' ? '凭据转换' : '凭据导入'
</script>

<template>
  <div class="admin-page pool-page">
    <header class="resource-panel-header"><div><span class="admin-kicker">PRIVATE POOL</span><h2>专属号池</h2><p>账号与接码资源只进入自己的隔离分组，用量与公共号池保持同样的额度窗口展示。</p></div><div v-if="poolStatus !== 'pending' || data" class="resource-panel-actions"><button v-if="pool" class="button button--quiet button--small" :disabled="loading" @click="refreshPool"><IconRefresh :size="15" />刷新用量</button><template v-if="activeTab === 'accounts'"><button class="button button--secondary" :disabled="!pool || saving" @click="openOAuth"><IconLogin2 :size="17" />Auth 登录</button><button class="button button--primary" :disabled="!pool || saving" @click="openImport('manual')"><IconPlus :size="17" />导入账号</button></template><button v-else class="button button--primary" :disabled="!pool" @click="openReceiverCreate()"><IconPlus :size="17" />新增接码</button><button v-if="!pool" class="button button--primary" :disabled="provisioning || !poolEntitlement.allowed" @click="provision"><IconShieldLock :size="17" />{{ provisioning ? '创建中…' : '创建专属号池' }}</button></div></header>
    <nav v-if="pool" class="admin-page-tabs pool-tabs" role="tablist" aria-label="专属资源管理"><button type="button" role="tab" :aria-selected="activeTab === 'accounts'" :class="{ active: activeTab === 'accounts' }" @click="activeTab = 'accounts'; search = ''"><IconShieldLock :size="17" />账号管理</button><button type="button" role="tab" :aria-selected="activeTab === 'receivers'" :class="{ active: activeTab === 'receivers' }" @click="activeTab = 'receivers'; search = ''"><IconDeviceMobile :size="17" />接码管理</button></nav>
    <template v-if="pool && activeTab === 'accounts'">
      <p class="pool-status-line"><span>{{ pool.status === 'active' ? '运行中' : '需处理' }}</span><span>{{ pool.displayName }}</span><span class="tabular-nums">账号 {{ pool.accountCount }}<template v-if="pool.maxAccounts"> / {{ pool.maxAccounts }}</template></span><span class="tabular-nums">可调度 {{ pool.availableAccountCount }}</span><span class="tabular-nums">待授权 {{ vaultAccounts.length }}</span><span>仅自己可用，不跨用户故障转移</span></p>
      <section class="pool-toolbar"><label class="admin-search"><IconSearch :size="16" /><input v-model="search" type="search" placeholder="搜索账号、邮箱或平台"></label><button class="icon-button" title="刷新账号" aria-label="刷新账号" :disabled="loading" @click="refreshPool"><IconRefresh :class="{ 'is-spinning': loading }" :size="17" /></button></section>
      <section v-if="vaultAccounts.length" class="pool-vault-section"><header><div><strong>账号资料</strong><small>手动与批量导入，等待授权进入专属分组</small></div><code>{{ vaultAccounts.length }}</code></header><div class="admin-table-wrap pool-table-wrap"><table class="admin-table"><thead><tr><th>账号</th><th>来源</th><th>凭据</th><th>接码</th><th>状态</th></tr></thead><tbody><tr v-for="item in vaultAccounts.filter(row => !search || `${row.email} ${row.displayName || ''} ${row.source}`.toLowerCase().includes(search.toLowerCase()))" :key="item.id"><td><strong>{{ item.displayName || item.email }}</strong><code>{{ item.email }}</code></td><td>{{ accountSourceLabels[item.source] }}</td><td>{{ item.credentialKind === 'tokens' ? 'AT / RT' : item.credentialKind === 'email_code_url' ? '邮箱链接' : '密码' }}<code v-if="item.hasTotpSecret">含 2FA</code></td><td><strong>{{ item.smsReceiver?.phone || '自动分配失败' }}</strong></td><td><span class="status-dot" data-status="disabled"><i />待授权</span><code>{{ item.status }}</code></td></tr></tbody></table></div></section>
    <section class="admin-table-wrap pool-table-wrap"><table class="admin-table upstream-table"><thead><tr><th>账号</th><th>平台 / 类型</th><th>来源</th><th>接码</th><th>用量</th><th>调度</th><th>最近验活</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in filteredAccounts" :key="item.id"><td><strong>{{ item.displayName }}</strong><code>{{ item.email || '未提供邮箱' }}</code></td><td>{{ item.platform }}<code>{{ item.accountType }}</code></td><td>{{ sourceLabel(item.source) }}<code>专属分组</code></td><td><strong>{{ receiverForAccount(item.id)?.phone || '未绑定' }}</strong><code v-if="accountCodes[item.id]?.code">验证码 {{ accountCodes[item.id]?.code }}</code></td><td><strong>{{ usageLabel(item.id) }}</strong><code v-if="!usageWindows(item.id).length">{{ usageDetail(item.id) }}</code><code v-for="window in usageWindows(item.id)" :key="window.label">{{ window.label }} · {{ window.remainingPercent === null ? (window.remaining ?? '—') : `${window.remainingPercent.toFixed(1)}%` }}</code></td><td><span class="status-dot" :data-status="item.schedulable ? 'active' : 'disabled'"><i />{{ item.schedulable ? '调度中' : '不可调度' }}</span><code>{{ item.status }}</code></td><td><strong>{{ date(item.lastVerifiedAt) }}</strong><code v-if="item.lastError" class="pool-error" :title="item.lastError">{{ item.lastError }}</code></td><td><div class="table-actions"><button v-if="receiverForAccount(item.id)" class="icon-button" title="获取并复制验证码" aria-label="获取并复制验证码" @click="refreshAccountCode(item)"><IconMessageCode :size="16" /></button><button class="icon-button" title="仅验证" aria-label="仅验证账号" :disabled="verifying === item.id" @click="verify(item)"><IconCircleCheck :size="16" /></button><button v-if="!item.schedulable" class="icon-button" title="验证并启用" aria-label="验证并启用账号" :disabled="verifying === item.id" @click="verify(item, true)"><IconPlayerPlay :size="16" /></button><button class="icon-button" title="编辑账号" aria-label="编辑账号" @click="openEdit(item)"><IconEdit :size="16" /></button><button class="icon-button danger" title="删除账号" aria-label="删除账号" @click="deleting = item"><IconTrash :size="16" /></button></div></td></tr><tr v-if="!filteredAccounts.length"><td colspan="8"><div class="admin-empty">{{ search ? '没有匹配的账号' : '还没有专属账号' }}</div></td></tr></tbody></table></section>
    </template>
    <template v-else-if="pool && activeTab === 'receivers'">
      <p class="pool-status-line"><span class="tabular-nums">接码资源 {{ receiverSummary.total }}</span><span class="tabular-nums">空余名额 {{ receiverSummary.available }}</span><span>每个号码最多绑定 3 个账号</span><span>仅当前账号可见，接口 URL 加密保存</span></p>
      <section class="pool-toolbar"><label class="admin-search"><IconSearch :size="16" /><input v-model="search" type="search" placeholder="搜索手机号、供应商或备注"></label><button class="icon-button" title="刷新接码列表" aria-label="刷新接码列表" @click="() => refreshReceivers()"><IconRefresh :size="17" /></button></section>
      <section class="admin-table-wrap pool-table-wrap"><table class="admin-table"><thead><tr><th>手机号</th><th>供应商</th><th>绑定</th><th>状态</th><th>最新验证码</th><th>最近刷新</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="item in receivers.filter(receiver => !search || `${receiver.phone} ${receiver.providerHost} ${receiver.note || ''}`.toLowerCase().includes(search.toLowerCase()))" :key="item.id"><td><strong>{{ item.phone }}</strong><code>{{ item.note || '无备注' }}</code></td><td><code>{{ item.providerHost }}</code></td><td><strong>{{ item.bindingCount }}/3</strong><code>{{ item.availableSlots }} 个空余</code></td><td><label class="compact-switch"><input type="checkbox" :checked="item.status === 'active'" @change="toggleReceiver(item, ($event.target as HTMLInputElement).checked)"><span aria-hidden="true" /><em>{{ item.status === 'active' ? '可用' : '停用' }}</em></label></td><td><strong>{{ receiverCodes[item.id]?.code || '—' }}</strong><code>{{ receiverCodes[item.id]?.message || '尚未获取' }}</code></td><td><strong>{{ item.lastFetchedAt ? date(item.lastFetchedAt) : '尚未刷新' }}</strong><code v-if="item.lastFetchError" class="pool-error">{{ item.lastFetchError }}</code></td><td><div class="table-actions"><button class="icon-button" title="刷新验证码" aria-label="刷新验证码" :disabled="item.status !== 'active'" @click="refreshReceiverCode(item)"><IconRefresh :size="16" /></button><button class="icon-button" title="编辑接码" aria-label="编辑接码" @click="openReceiverCreate(item)"><IconEdit :size="16" /></button><button class="icon-button danger" title="删除接码" aria-label="删除接码" :disabled="item.bindingCount > 0 && !item.readyForDeletion" @click="deleteReceiver(item)"><IconTrash :size="16" /></button></div></td></tr><tr v-if="!receivers.length"><td colspan="7"><div class="admin-empty">还没有接码资源</div></td></tr></tbody></table></section>
    </template>
    <div v-else-if="poolStatus === 'pending' && !data" class="admin-panel pool-empty"><IconRefresh class="is-spinning" :size="24" /><h2>正在加载专属号池</h2></div>
    <div v-else-if="!provisioning" class="admin-panel pool-empty"><IconShieldLock :size="26" /><h2>{{ poolEntitlement.allowed ? '还没有专属号池' : '当前套餐不可用' }}</h2><p>{{ poolEntitlement.allowed ? `启用后，账号只会进入你的专属分组${poolEntitlement.maxAccounts ? `，最多 ${poolEntitlement.maxAccounts} 个` : ''}。` : '请联系管理员检查套餐状态。' }}</p></div>

    <AppDrawer :open="drawer === 'import'" wide kicker="ACCOUNT RECORD" title="新增账号" @close="drawer = null">
      <form class="admin-form pool-account-importer" @submit.prevent="submitImport">
        <nav class="admin-page-tabs import-mode-tabs" role="tablist" aria-label="新增账号方式">
          <button type="button" role="tab" :aria-selected="importMode === 'manual'" :class="{ active: importMode === 'manual' }" @click="switchImportMode('manual')">手动</button>
          <button type="button" role="tab" :aria-selected="importMode === 'upload'" :class="{ active: importMode === 'upload' }" @click="switchImportMode('upload')">上传</button>
          <button type="button" role="tab" :aria-selected="importMode === 'batch'" :class="{ active: importMode === 'batch' }" @click="switchImportMode('batch')">批量导入</button>
          <button type="button" role="tab" :aria-selected="importMode === 'convert'" :class="{ active: importMode === 'convert' }" @click="switchImportMode('convert')">凭据转换</button>
        </nav>

        <section v-if="importMode === 'manual'" class="pool-import-section">
          <header><div><span>ACCOUNT</span><h3>账号资料</h3></div><small>身份、登录凭据与接码</small></header>
          <div class="form-grid"><label><span>邮箱 *</span><input v-model="manualForm.email" type="email" required autocomplete="off"></label><label><span>姓名</span><input v-model="manualForm.displayName" maxlength="120"></label></div>
          <div class="form-grid"><label><span>来源 *</span><AppSelect v-model="manualForm.source" required><option value="" disabled>请选择来源</option><option v-for="source in ACCOUNT_VAULT_SOURCES.filter(item => item !== 'unknown')" :key="source" :value="source">{{ accountSourceLabels[source] }}</option></AppSelect></label><label><span>账号状态</span><AppSelect v-model="manualForm.status"><option v-for="status in ACCOUNT_VAULT_STATUSES" :key="status" :value="status">{{ status }}</option></AppSelect></label></div>
          <label><span>账号密码</span><input v-model="manualForm.password" type="password" maxlength="2000" autocomplete="new-password"></label>
          <div class="form-grid"><label><span>邮箱验证码链接</span><input v-model="manualForm.emailCodeUrl" type="url" maxlength="4000" placeholder="https://"></label><label><span>2FA 密钥</span><input v-model="manualForm.totpSecret" type="password" maxlength="512" autocomplete="off" placeholder="Base32"></label></div>
          <label><span>接码手机号</span><AppSelect v-model="manualForm.smsReceiverId"><option value="">自动分配可用手机号</option><option v-for="item in receivers.filter(receiver => receiver.status === 'active' && receiver.availableSlots > 0)" :key="item.id" :value="item.id">{{ item.phone }} · {{ item.bindingCount }}/3</option></AppSelect><small>没有可用号码时仍会创建账号。</small></label>
          <label><span>备注</span><textarea v-model="manualForm.remark" maxlength="2000" rows="4" /></label>
        </section>

        <section v-else-if="importMode === 'batch'" class="pool-import-section pool-batch-import">
          <header><div><span>BATCH</span><h3>批量数据</h3></div><small>结构化发货文本</small></header>
          <div class="delivery-config-grid"><label><span>来源 *</span><AppSelect v-model="deliverySource" :disabled="saving"><option value="" disabled>请选择来源</option><option v-for="source in ACCOUNT_VAULT_SOURCES.filter(item => item !== 'unknown')" :key="source" :value="source">{{ accountSourceLabels[source] }}</option></AppSelect></label><fieldset class="delivery-field-picker"><legend>本批包含的字段</legend><div><label v-for="field in deliveryFieldOptions" :key="field.value"><input type="checkbox" :checked="deliveryFields.includes(field.value)" :disabled="field.value === 'email' || saving" @change="toggleDeliveryField(field.value)"><span>{{ field.label }}</span></label></div></fieldset></div>
          <fieldset class="delivery-field-order"><legend>字段顺序</legend><ol><li v-for="(field, index) in deliveryFields" :key="field"><code>{{ index + 1 }}</code><span>{{ deliveryFieldLabels[field] }}</span><button type="button" title="上移字段" :disabled="index === 0 || saving" @click="moveDeliveryField(field, -1)"><IconArrowUp :size="14" /></button><button type="button" title="下移字段" :disabled="index === deliveryFields.length - 1 || saving" @click="moveDeliveryField(field, 1)"><IconArrowDown :size="14" /></button></li></ol><small>每行按照以上顺序使用 <code>----</code> 分隔。</small></fieldset>
          <p v-if="deliveryConfigurationError" class="form-error">{{ deliveryConfigurationError }}</p>
          <div class="pool-batch-layout"><label><span>发货内容 *</span><textarea v-model="deliveryText" required rows="12" spellcheck="false" :placeholder="selectedDeliveryFormat.placeholder" /></label><aside><header><div><span>PREVIEW</span><h3>导入预览</h3><small>{{ selectedDeliveryFormat.label }}</small></div><code>{{ deliveryPreview.length }}</code></header><div v-if="deliveryPreview.length" class="vault-delivery-preview"><div v-for="item in deliveryPreview.slice(0, 50)" :key="item.index" :data-valid="item.valid"><code>{{ item.email }}</code><span>{{ item.kind }}</span></div><small v-if="deliveryPreview.length > 50">另有 {{ deliveryPreview.length - 50 }} 条待导入</small></div><div v-else class="account-editor-empty">暂无可预览账号</div></aside></div>
        </section>

        <section v-else class="pool-import-section credential-editor">
          <header><div><span>{{ importMode === 'upload' ? 'UPLOAD' : 'CREDENTIALS' }}</span><h3>{{ importMode === 'upload' ? '上传内容' : '凭据来源' }}</h3><small>{{ importMode === 'upload' ? 'Sub2API 账号 JSON' : 'Session 或认证 JSON' }}</small></div><label class="button button--quiet button--small"><IconCloudUpload :size="15" />选择文件<input type="file" accept="application/json,.json" :multiple="importMode === 'convert'" hidden @change="credentialFile"></label></header>
          <label v-if="importMode === 'upload'"><span>号池平台 *</span><AppSelect model-value="sub2api" disabled><option value="sub2api">Sub2API</option></AppSelect><small>用户专属号池固定导入当前账号的 Sub2API 隔离分组。</small></label>
          <div class="credential-selection" :data-selected="Boolean(credentialFileName)"><IconFileCode :size="20" /><div><strong>{{ credentialFileName || '尚未选择文件' }}</strong><small>{{ importRows.length ? `已解析 ${importRows.length} 个账号` : importMode === 'upload' ? '支持完整导出包、批量账号或单账号 JSON' : '最多 20 个 JSON 文件' }}</small></div></div>
          <button type="button" class="button button--quiet button--small" @click="showCredentialPaste = !showCredentialPaste">{{ showCredentialPaste ? '收起粘贴内容' : '粘贴 JSON 内容' }}</button>
          <textarea v-if="showCredentialPaste" v-model="importText" rows="8" spellcheck="false" placeholder="粘贴凭据 JSON" />
          <button v-if="showCredentialPaste" type="button" class="button button--secondary button--small" @click="parsePastedCredentials">解析内容</button>
          <div v-if="importRows.length" class="import-account-list"><article v-for="(row, index) in importRows" :key="row.key" class="import-account-row"><header><span>{{ index + 1 }}</span><div><strong>{{ row.name }}</strong><small>{{ row.email || '未提供邮箱' }} · {{ row.platform }} / {{ row.type }}</small></div><code>{{ row.concurrency }} 并发 · P{{ row.priority }}</code></header><small class="pool-import-note">强制绑定当前专属分组，导入后先保持不可调度。</small></article></div>
        </section>

        <p v-if="importNotice" class="form-notice">{{ importNotice }}</p><p v-if="error || deliveryError" class="form-error pre-line">{{ error || deliveryError }}</p>
        <footer><span v-if="importMode === 'batch'">{{ deliveryPreview.length }} 个账号</span><span v-else-if="importMode === 'upload' || importMode === 'convert'">{{ importRows.length }} 个账号</span><button type="button" class="button button--secondary" @click="drawer = null">取消</button><button class="button button--primary" :disabled="saving || (importMode === 'batch' ? !deliverySource || Boolean(deliveryConfigurationError) || !deliveryPreview.length : (importMode === 'upload' || importMode === 'convert') ? !importReady : false)">{{ saving ? '处理中' : importMode === 'manual' ? '保存账号' : importMode === 'batch' ? '确认导入' : '导入并停用' }}</button></footer>
      </form>
    </AppDrawer>

    <AppDrawer :open="drawer === 'oauth'" kicker="SUB2API OAUTH" title="Auth 登录" @close="drawer = null"><form class="admin-form" @submit.prevent="oauth.flowId ? completeOAuth() : startOAuth"><template v-if="!oauth.flowId"><p class="pool-drawer-copy">通过 OpenAI Auth 完成授权，账号会进入当前专属分组，授权完成后先保持不可调度。</p><div class="form-grid"><label><span>账号名称</span><input v-model="oauth.name" placeholder="留空时使用 OpenAI 账号邮箱"></label></div></template><template v-else><section class="oauth-link-section"><header><div><h3>授权链接</h3><span>{{ oauth.expiresAt ? `有效至 ${date(oauth.expiresAt)}` : '15 分钟内有效' }}</span></div><div><button type="button" class="button button--quiet button--small" @click="copyUrl"><IconCopy :size="15" />复制</button><button type="button" class="button button--secondary button--small" @click="openUrl"><IconExternalLink :size="15" />打开</button></div></header><input :value="oauth.authorizationUrl" readonly aria-label="OpenAI 授权链接" @focus="selectOAuthUrl"></section><label><span>localhost 回调 URL *</span><textarea v-model="oauth.callbackUrl" rows="5" required spellcheck="false" placeholder="http://localhost:1455/auth/callback?code=...&state=..."></textarea></label></template><p v-if="oauthError" class="form-error">{{ oauthError }}</p><footer><button type="button" class="button button--secondary" @click="drawer = null">取消</button><button v-if="oauth.flowId" type="button" class="button button--quiet" @click="openOAuth">重新生成</button><button class="button button--primary" :disabled="saving || (Boolean(oauth.flowId) && !oauth.callbackUrl.trim())"><IconLogin2 :size="16" />{{ saving ? '处理中' : oauth.flowId ? '完成授权' : '生成授权链接' }}</button></footer></form></AppDrawer>

    <AppDrawer v-if="editing" :open="drawer === 'edit'" kicker="SUB2API ACCOUNT" :title="`编辑 ${editing.displayName}`" @close="drawer = null"><form class="admin-form" @submit.prevent="saveEdit"><label><span>账号名称 *</span><input v-model="editForm.displayName" required maxlength="160"></label><label><span>接码手机号</span><AppSelect v-model="editReceiverId"><option value="">不绑定接码</option><option v-for="item in receivers.filter(receiver => receiver.status === 'active' && (receiver.availableSlots > 0 || receiver.id === receiverForAccount(editing!.id)?.id))" :key="item.id" :value="item.id">{{ item.phone }} · {{ item.availableSlots }} 个空余</option></AppSelect></label><label class="switch"><input v-model="editForm.schedulable" type="checkbox"><span />允许调度</label><p class="pool-drawer-copy">平台、账号类型和所属分组由专属号池托管，不能在用户侧修改。</p><p v-if="error" class="form-error">{{ error }}</p><footer><button type="button" class="button button--secondary" @click="drawer = null">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存配置' }}</button></footer></form></AppDrawer>
    <AppDrawer :open="drawer === 'receiver'" kicker="SMS RECEIVER" :title="editingReceiver ? '编辑接码' : '新增接码'" @close="drawer = null"><form class="admin-form" @submit.prevent="saveReceiver"><nav v-if="!editingReceiver" class="admin-page-tabs import-mode-tabs" role="tablist" aria-label="接码新增方式"><button type="button" role="tab" :aria-selected="receiverCreateMode === 'single'" :class="{ active: receiverCreateMode === 'single' }" @click="receiverCreateMode = 'single'">单个添加</button><button type="button" role="tab" :aria-selected="receiverCreateMode === 'batch'" :class="{ active: receiverCreateMode === 'batch' }" @click="receiverCreateMode = 'batch'">批量导入</button></nav><template v-if="editingReceiver || receiverCreateMode === 'single'"><label><span>接码手机号 *</span><input v-model="receiverForm.phone" required maxlength="40" inputmode="tel"></label><label><span>{{ editingReceiver ? '接码接口 URL（留空保持不变）' : '接码接口 URL *' }}</span><input v-model="receiverForm.fetchUrl" type="url" :required="!editingReceiver" maxlength="3000" placeholder="https://"></label><label><span>备注</span><input v-model="receiverForm.note" maxlength="500"></label><label class="switch"><input v-model="receiverForm.active" type="checkbox"><span />启用接码</label></template><label v-else><span>批量内容 *</span><textarea v-model="receiverImportText" rows="10" required spellcheck="false" placeholder="手机号|接码接口 URL&#10;手机号|接码接口 URL"></textarea></label><p v-if="receiverError" class="form-error pre-line">{{ receiverError }}</p><footer><button type="button" class="button button--secondary" @click="drawer = null">取消</button><button class="button button--primary" :disabled="receiverBusy">{{ receiverBusy ? '保存中' : editingReceiver ? '保存接码' : receiverCreateMode === 'batch' ? '批量导入' : '新增接码' }}</button></footer></form></AppDrawer>
    <AppConfirmDialog :open="Boolean(deleting)" title="删除账号" :message="`删除“${deleting?.displayName || ''}”后，该账号会从专属号池移除。`" :busy="loading" @close="deleting = null" @confirm="remove" />
  </div>
</template>

<style scoped>
.pool-page { width:100%; }
.pool-tabs { margin-bottom:1rem; }
.pool-status-line { margin:0 0 .75rem; display:flex; flex-wrap:wrap; align-items:center; gap:.25rem .55rem; color:var(--text-muted); font-size:.7rem; line-height:1.5; }
.pool-status-line > span { display:inline-flex; align-items:center; gap:.25rem; }
.pool-status-line > span + span::before { content:'·'; margin-right:.3rem; color:var(--line-strong); }
.import-mode-tabs { margin-bottom:.25rem; }
.pre-line { white-space:pre-line; }
.pool-account-importer { gap:1rem; }
.pool-account-importer > footer { display:flex; align-items:center; justify-content:flex-end; gap:.55rem; }
.pool-account-importer > footer > span { margin-right:auto; color:var(--text-muted); font-size:.72rem; }
.pool-import-section { display:grid; gap:.85rem; }
.pool-import-section > header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; padding-bottom:.65rem; border-bottom:1px solid var(--line-subtle); }
.pool-import-section > header > div { display:grid; gap:.2rem; }
.pool-import-section > header span,.pool-batch-layout aside > header span { color:var(--accent); font:600 .62rem/1 var(--font-mono, monospace); }
.pool-import-section > header h3,.pool-batch-layout aside > header h3 { margin:0; font-size:.9rem; }
.pool-import-section > header small,.pool-batch-layout aside > header small { color:var(--text-muted); font-size:.68rem; }
.delivery-config-grid { display:grid; grid-template-columns:minmax(180px,.7fr) minmax(0,1.3fr); gap:.8rem; align-items:start; }
.delivery-field-picker,.delivery-field-order { min-width:0; margin:0; padding:0; border:0; }
.delivery-field-picker legend,.delivery-field-order legend { margin-bottom:.45rem; padding:0; color:var(--text-muted); font-size:.68rem; }
.delivery-field-picker > div { display:flex; flex-wrap:wrap; gap:.45rem; }
.delivery-field-picker label { position:relative; cursor:pointer; }
.pool-account-importer .delivery-field-picker input { position:absolute; width:1px; height:1px; min-height:1px; padding:0; opacity:0; }
.delivery-field-picker label > span { min-height:2rem; padding:.35rem .55rem; border:1px solid var(--line-subtle); border-radius:5px; display:inline-flex; align-items:center; color:var(--text-muted); background:var(--surface-soft); font-size:.66rem; white-space:nowrap; }
.delivery-field-picker input:checked + span { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb, var(--accent) 10%, transparent); }
.delivery-field-picker input:focus-visible + span { outline:2px solid var(--accent); outline-offset:2px; }
.delivery-field-picker input:disabled + span { cursor:default; opacity:.72; }
.delivery-field-order { padding:.75rem; border:1px solid var(--line-subtle); border-radius:7px; background:var(--surface-soft); }
.delivery-field-order ol { display:flex; flex-wrap:wrap; gap:.4rem; margin:0; padding:0; list-style:none; }
.delivery-field-order li { min-width:8rem; min-height:2.2rem; padding:.3rem .38rem; display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; align-items:center; gap:.3rem; border:1px solid var(--line-subtle); border-radius:5px; background:var(--surface); font-size:.7rem; }
.delivery-field-order li > code { color:var(--accent); text-align:center; }
.delivery-field-order li button { width:25px; height:25px; display:grid; place-items:center; padding:0; border:0; color:var(--text-muted); background:transparent; cursor:pointer; }
.delivery-field-order > small { margin-top:.55rem; display:block; color:var(--text-muted); font-size:.68rem; }
.pool-batch-layout { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(240px,.75fr); gap:.8rem; align-items:stretch; }
.pool-batch-layout > label textarea { min-height:280px; font:12px/1.5 var(--font-mono, monospace); }
.pool-batch-layout aside { min-width:0; padding:.75rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.pool-batch-layout aside > header { display:flex; align-items:flex-start; justify-content:space-between; gap:.6rem; margin-bottom:.65rem; }
.pool-batch-layout aside > header > div { display:grid; gap:.2rem; }
.pool-batch-layout aside > header > code { color:var(--accent); }
.vault-delivery-preview { display:grid; gap:.35rem; max-height:270px; overflow:auto; }
.vault-delivery-preview > div { display:flex; justify-content:space-between; gap:.5rem; padding:.45rem; border:1px solid var(--line-subtle); background:var(--surface); }
.vault-delivery-preview > div[data-valid=false] { color:#b42318; border-color:#f2c5c0; }
.vault-delivery-preview code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vault-delivery-preview span { flex:none; font-size:.65rem; }
.account-editor-empty { min-height:150px; display:grid; place-items:center; color:var(--text-muted); font-size:.72rem; }
.pool-vault-section { margin-bottom:1rem; border:1px solid var(--line-subtle); }
.pool-vault-section > header { min-height:52px; padding:.65rem .8rem; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line-subtle); background:var(--surface-soft); }
.pool-vault-section > header > div { display:grid; gap:.2rem; }
.pool-vault-section > header small { color:var(--text-muted); font-size:.68rem; }
.resource-panel-header { min-height:72px; margin-bottom:1rem; display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
.resource-panel-header h2 { margin-top:.25rem; font-size:1.25rem; }
.resource-panel-header p { margin-top:.35rem; color:var(--text-muted); font-size:.78rem; }
.resource-panel-actions { display:flex; align-items:center; gap:.55rem; flex-wrap:wrap; justify-content:flex-end; }
.pool-toolbar { display:flex; align-items:center; gap:.55rem; margin-bottom:.75rem; }
.pool-toolbar .admin-search { flex:1; }
.pool-table-wrap { overflow:auto; }
.pool-table-wrap td { vertical-align:middle; }
.pool-table-wrap td > strong,.pool-table-wrap td > code { display:block; }
.pool-table-wrap td > code { margin-top:.25rem; color:var(--text-muted); font-size:.68rem; }
.pool-error { max-width:240px; overflow:hidden; color:#b42318 !important; text-overflow:ellipsis; white-space:nowrap; }
.credential-editor { display:grid; gap:.85rem; }
.credential-editor > header,.oauth-link-section > header { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.credential-editor > header > div,.oauth-link-section > header > div:first-child { display:grid; gap:.25rem; }
.credential-editor h3,.oauth-link-section h3 { margin:0; font-size:.86rem; }
.credential-editor header span,.oauth-link-section header span { color:var(--text-muted); font-size:.7rem; }
.credential-editor label input[type=file] { display:none; }
.credential-selection { min-height:64px; display:flex; align-items:center; gap:.65rem; padding:.8rem; border:1px dashed var(--line-strong); background:var(--surface-soft); }
.credential-selection > div { min-width:0; display:grid; gap:.2rem; }
.credential-selection strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.credential-selection small { color:var(--text-muted); font-size:.68rem; }
.credential-editor textarea { min-height:140px; resize:vertical; font:12px/1.5 var(--font-mono, monospace); }
.import-account-list { display:grid; gap:.55rem; max-height:340px; overflow:auto; }
.import-account-row { padding:.7rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.import-account-row > header { display:grid; grid-template-columns:26px minmax(0,1fr) auto; align-items:center; gap:.55rem; }
.import-account-row > header > span { color:var(--accent); font:700 .72rem var(--font-mono); }
.import-account-row > header > div { min-width:0; display:grid; gap:.2rem; }
.import-account-row > header strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.import-account-row > header small,.import-account-row > header code,.pool-import-note,.pool-drawer-copy { color:var(--text-muted); font-size:.68rem; }
.pool-import-note { display:block; margin-top:.45rem; }
.oauth-link-section { display:grid; gap:.6rem; padding:.8rem; border:1px solid var(--line-subtle); background:var(--surface-soft); }
.oauth-link-section > header > div:last-child { display:flex; gap:.35rem; }
.oauth-link-section input { min-width:0; width:100%; }
.form-notice { padding:.65rem .8rem; border:1px solid #b8e3d2; color:#147d5a; background:#effaf5; font-size:.72rem; }
.pool-empty { min-height:220px; display:grid; place-items:center; align-content:center; gap:.5rem; text-align:center; }
.pool-empty p { margin:0; color:var(--text-muted); }
@media (max-width:700px) { .resource-panel-header { flex-direction:column; } .resource-panel-actions { width:100%; justify-content:flex-start; } .resource-panel-actions .button { flex:1; justify-content:center; } .import-account-row > header { grid-template-columns:22px minmax(0,1fr); } .import-account-row > header code { grid-column:2; } .delivery-config-grid,.pool-batch-layout { grid-template-columns:1fr; } .pool-account-importer > footer { flex-wrap:wrap; } .pool-account-importer > footer > span { width:100%; } }
</style>
