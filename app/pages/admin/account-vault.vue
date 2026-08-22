<script setup lang="ts">
import {
  IconAddressBook,
  IconArrowDown,
  IconArrowUp,
  IconCircleCheck,
  IconCloudUpload,
  IconCopy,
  IconDeviceMobile,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconFileCode,
  IconLink,
  IconLock,
  IconLogin2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconTrash,
  IconUsers,
  IconX
} from '@tabler/icons-vue'
import {
  ACCOUNT_DELIVERY_FIELDS,
  ACCOUNT_VAULT_STATUSES,
  ACCOUNT_VAULT_SOURCES,
  type AccountDeliveryField,
  type AccountSub2ApiPoolStatus,
  type AccountTotpCodeResult,
  type AccountVaultStatus,
  type AccountVaultSource,
  type AccountVaultView,
  type SmsCodeResult,
  type SmsReceiverImportResult,
  type SmsReceiverView
} from '#shared/types/accounting'
import type { Sub2ApiAccountQuotaResult, Sub2ApiAccountsResponse } from '#shared/types/sub2api-admin'
import type {
  CpaAuthFileView,
  ProxyPoolState,
  SubAccountManagementView,
  SubGroupView,
  SubProxyView
} from '#shared/types/upstream-management'
import { clientRandomUUID } from '#shared/utils/client-random'
import {
  convertCredentialDocuments,
  convertCredentialSourceText,
  cpaCredentialFileName,
  parseCredentialSourceText,
  type ConvertedCredentialAccount,
  type CredentialImportTarget,
  type CredentialSourceDocument,
  type SkippedCredentialSource
} from '#shared/utils/credential-converter'

definePageMeta({ layout: 'admin', middleware: ['admin', 'account-admin'] })
useSeoMeta({ title: '账号管理 | Zephyr Hub' })

type PageTab = 'accounts' | 'receivers'
type AccountCreateMode = 'manual' | 'upload' | 'batch' | 'convert'
type DeleteTarget =
  | { kind: 'vault'; item: AccountVaultView }
  | { kind: 'sub'; item: SubAccountManagementView }
  | { kind: 'cpa'; item: CpaAuthFileView }
  | { kind: 'receiver'; item: SmsReceiverView }
  | { kind: 'binding'; receiver: SmsReceiverView; account: SmsReceiverView['accounts'][number] }
  | { kind: 'bulk-accounts'; items: UnifiedAccountRow[] }
  | { kind: 'bulk-receivers'; items: SmsReceiverView[] }

interface UnifiedAccountRow {
  key: string
  vault: AccountVaultView | null
  sub: SubAccountManagementView | null
  subPoolStatus: AccountSub2ApiPoolStatus | null
  cpaFiles: CpaAuthFileView[]
  quota: Sub2ApiAccountQuotaResult | null
}

interface ImportAccountRow {
  key: string
  name: string
  email: string | null
  platform: string
  type: string
  credentials: Record<string, unknown>
  extra: Record<string, unknown>
  concurrency: number
  priority: number
  rateMultiplier: number
  groupIds: string[]
  proxyId: string | null
}

type ConversionTargetState = 'idle' | 'loading' | 'success' | 'error'
interface ConversionAccountRow extends ConvertedCredentialAccount {
  selected: boolean
  targets: CredentialImportTarget[]
  cpaState: ConversionTargetState
  cpaError: string | null
  sub2apiState: ConversionTargetState
  sub2apiError: string | null
}

const { show: showToast } = useAppToast()
const { data: vaultData, refresh: refreshVault } = await useFetch<{ items: AccountVaultView[] }>('/api/admin/account-vault')
const { data: managedData, refresh: refreshManaged } = useLazyFetch<{ accounts: SubAccountManagementView[] }>('/api/admin/upstreams/sub/accounts')
const { data: receiverData, refresh: refreshReceivers } = useLazyFetch<{ items: SmsReceiverView[] }>('/api/admin/sms-receivers')
const { data: cpaData, refresh: refreshCpa } = useLazyFetch<{ files: CpaAuthFileView[] }>('/api/admin/upstreams/cpa/auth-files')
const { data: quotaData, refresh: refreshQuotas } = useLazyFetch<Sub2ApiAccountsResponse>('/api/sub2api/accounts')
const { data: groupData, refresh: refreshGroups } = useLazyFetch<{ groups: SubGroupView[] }>('/api/admin/upstreams/sub/groups')
const { data: proxyData, refresh: refreshProxies } = useLazyFetch<ProxyPoolState>('/api/admin/upstreams/sub/proxies')

const activeTab = ref<PageTab>('accounts')
const search = ref('')
const loadingAll = ref(false)
const accountPasswords = reactive<Record<string, string>>({})
const accountTotpCodes = reactive<Record<string, AccountTotpCodeResult>>({})
const totpTimers = new Map<string, number>()
const generatingTotp = reactive<Record<string, boolean>>({})
const refreshingAccountCodes = reactive<Record<string, boolean>>({})
const accountSmsCodes = reactive<Record<string, SmsCodeResult>>({})
const refreshingCodes = reactive<Record<string, boolean>>({})
const smsCodes = reactive<Record<string, SmsCodeResult>>({})
const subMutating = reactive<Record<string, boolean>>({})
const cpaMutating = reactive<Record<string, boolean>>({})
const quotaRefreshing = reactive<Record<string, boolean>>({})

const cpaUploadFiles = ref<File[]>([])
const cpaUploadSaving = ref(false)
const cpaUploadError = ref('')

const showForm = ref(false)
const editing = ref<AccountVaultView | null>(null)
const accountCreateMode = ref<AccountCreateMode>('manual')
const uploadPool = ref<'sub2api' | 'cpa'>('sub2api')
const saving = ref(false)
const formError = ref('')
const emailCodeUrlTouched = ref(false)
const totpSecretTouched = ref(false)
const deliveryText = ref('')
const deliveryFields = ref<AccountDeliveryField[]>(['email', 'password'])
const deliverySource = ref<AccountVaultSource | ''>('')
const deliveryImporting = ref(false)
const deliveryError = ref('')
const form = reactive({
  email: '',
  displayName: '',
  source: '' as AccountVaultSource | '',
  status: 'Codex' as AccountVaultStatus,
  password: '',
  emailCodeUrl: '',
  totpSecret: '',
  smsReceiverId: '' as string,
  remark: ''
})

const showExport = ref(false)
const exportPassword = ref('')
const exportError = ref('')

const showReceiverForm = ref(false)
const editingReceiver = ref<SmsReceiverView | null>(null)
const receiverSaving = ref(false)
const receiverError = ref('')
const receiverCreateMode = ref<'single' | 'batch'>('single')
const receiverImportText = ref('')
const receiverMutating = reactive<Record<string, boolean>>({})
const bindingMutating = reactive<Record<string, boolean>>({})
const receiverForm = reactive({ phone: '', fetchUrl: '', note: '', active: true })
const manualBindingSaving = ref(false)
const manualBindingError = ref('')
const manualBindingForm = reactive({ email: '', displayName: '' })

const selectedAccountKeys = ref<string[]>([])
const selectedReceiverIds = ref<string[]>([])

const oauthAccount = ref<AccountVaultView | null>(null)
const oauthSaving = ref(false)
const oauthError = ref('')
const oauthForm = reactive({
  name: '',
  concurrency: 10,
  priority: 0,
  groupIds: [] as string[],
  proxyId: null as string | null,
  schedulable: true,
  authorizationUrl: '',
  flowId: '',
  callbackUrl: '',
  expiresAt: null as number | null
})

const editingSub = ref<SubAccountManagementView | null>(null)
const subFormError = ref('')
const subForm = reactive({
  name: '',
  notes: '',
  concurrency: 10,
  priority: 0,
  rateMultiplier: 1,
  groupIds: [] as string[],
  proxyId: null as string | null,
  status: 'active',
  schedulable: true
})

const importSaving = ref(false)
const importError = ref('')
const importText = ref('')
const importFileName = ref('')
const importRows = ref<ImportAccountRow[]>([])
const importSchedulable = ref(true)
const importAdvancedRaw = ref(false)

const conversionInput = ref('')
const conversionRows = ref<ConversionAccountRow[]>([])
const conversionSkipped = ref<SkippedCredentialSource[]>([])
const conversionFileCount = ref(0)
const conversionError = ref('')
const conversionSaving = ref(false)
const conversionConfig = reactive({
  groupIds: [] as string[],
  proxyId: null as string | null,
  concurrency: 10,
  priority: 0,
  rateMultiplier: 1,
  schedulable: true
})

const deleting = ref<DeleteTarget | null>(null)
const deletingBusy = ref(false)

const groups = computed(() => groupData.value?.groups || [])
const proxies = computed(() => proxyData.value?.proxies || [])
const managedAccounts = computed(() => managedData.value?.accounts || [])
const managedCpaFiles = computed(() => cpaData.value?.files || [])
const quotas = computed(() => quotaData.value?.results || [])
const selectedConversionRows = computed(() => conversionRows.value.filter(item => item.selected))
const conversionCpaCount = computed(() => selectedConversionRows.value.filter(item => item.targets.includes('cpa') && item.cpaState !== 'success').length)
const conversionSub2ApiCount = computed(() => selectedConversionRows.value.filter(item => item.targets.includes('sub2api') && item.sub2apiState !== 'success').length)

watch(showForm, (open) => {
  if (!open && !conversionSaving.value) resetConversionForm()
})

function identity(value: string | null | undefined) {
  return (value || '').trim().toLowerCase()
}

const unifiedRows = computed<UnifiedAccountRow[]>(() => {
  const subById = new Map(managedAccounts.value.map(item => [item.id, item]))
  const subByIdentity = new Map<string, SubAccountManagementView>()
  const usedSubIds = new Set<string>()
  const usedCpaIds = new Set<string>()
  const quotaById = new Map(quotas.value.map(item => [item.id, item]))
  const cpaByIdentity = new Map<string, CpaAuthFileView[]>()
  managedAccounts.value.forEach((item) => {
    ;[item.email, item.name].map(identity).filter(Boolean).forEach((key) => {
      if (!subByIdentity.has(key)) subByIdentity.set(key, item)
    })
  })
  managedCpaFiles.value.forEach((item) => {
    const keys = new Set([
      identity(item.account),
      identity(item.name),
      identity(item.name.replace(/\.json$/i, ''))
    ].filter(Boolean))
    keys.forEach((key) => cpaByIdentity.set(key, [...(cpaByIdentity.get(key) || []), item]))
  })
  const takeCpaFiles = (values: Array<string | null | undefined>) => {
    const matches: CpaAuthFileView[] = []
    values.map(identity).filter(Boolean).forEach((key) => {
      ;(cpaByIdentity.get(key) || []).forEach((item) => {
        if (usedCpaIds.has(item.id)) return
        usedCpaIds.add(item.id)
        matches.push(item)
      })
    })
    return matches
  }
  const rows = (vaultData.value?.items || []).map((vault): UnifiedAccountRow => {
    const identityMatch = vault.sub2apiPoolStatus === 'deleted'
      ? null
      : subByIdentity.get(identity(vault.email))
        || (vault.displayName ? subByIdentity.get(identity(vault.displayName)) : null)
    const sub = (vault.sub2apiAccountId ? subById.get(vault.sub2apiAccountId) : null)
      || identityMatch
      || null
    if (sub) usedSubIds.add(sub.id)
    const cpaFiles = takeCpaFiles([vault.email, vault.displayName, sub?.email, sub?.name])
    const subPoolStatus = sub
      ? 'active'
      : vault.sub2apiPoolStatus === 'active' && managedData.value
        ? 'deleted'
        : vault.sub2apiPoolStatus
    return { key: `vault:${vault.id}`, vault, sub, subPoolStatus, cpaFiles, quota: sub ? quotaById.get(sub.id) || null : null }
  })
  managedAccounts.value.forEach((sub) => {
    if (!usedSubIds.has(sub.id)) {
      rows.push({
        key: `sub:${sub.id}`,
        vault: null,
        sub,
        subPoolStatus: 'active',
        cpaFiles: takeCpaFiles([sub.email, sub.name]),
        quota: quotaById.get(sub.id) || null
      })
    }
  })
  const unmatchedGroups = new Map<string, CpaAuthFileView[]>()
  managedCpaFiles.value.forEach((item) => {
    if (usedCpaIds.has(item.id)) return
    const key = identity(item.account) || identity(item.name.replace(/\.json$/i, '')) || item.id
    unmatchedGroups.set(key, [...(unmatchedGroups.get(key) || []), item])
  })
  unmatchedGroups.forEach((cpaFiles) => {
    rows.push({ key: `cpa:${cpaFiles[0]!.id}`, vault: null, sub: null, subPoolStatus: null, cpaFiles, quota: null })
  })
  return rows.sort((left, right) => {
    const healthDifference = accountSortRank(left) - accountSortRank(right)
    if (healthDifference) return healthDifference
    const timeDifference = accountSortTime(right) - accountSortTime(left)
    if (timeDifference) return timeDifference
    return accountEmail(left).localeCompare(accountEmail(right), 'zh-CN')
  })
})

const filteredRows = computed(() => {
  const needle = search.value.trim().toLowerCase()
  if (!needle) return unifiedRows.value
  return unifiedRows.value.filter(({ vault, sub, cpaFiles }) => `${vault?.email || ''} ${vault?.displayName || ''} ${vault?.source || ''} ${vault ? sourceLabel(vault.source) : ''} ${vault?.smsReceiver?.phone || ''} ${vault?.remark || ''} ${sub?.name || ''} ${sub?.platform || ''} ${sub?.type || ''} ${sub?.groupNames.join(' ') || ''} ${cpaFiles.map(item => `${item.name} ${item.account || ''} ${item.provider}`).join(' ')}`.toLowerCase().includes(needle))
})

const filteredReceivers = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const items = receiverData.value?.items || []
  return needle ? items.filter(item => `${item.phone} ${item.providerHost} ${item.note || ''} ${item.accounts.map(account => account.email).join(' ')}`.toLowerCase().includes(needle)) : items
})

const selectableAccountRows = computed(() => filteredRows.value.filter(row => Boolean(row.vault || row.sub || row.cpaFiles.length)))
const selectableReceivers = computed(() => filteredReceivers.value.filter(receiver => receiver.bindingCount === 0 || receiver.readyForDeletion))
const selectedAccountRows = computed(() => {
  const selected = new Set(selectedAccountKeys.value)
  return unifiedRows.value.filter(row => selected.has(row.key) && (row.vault || row.sub || row.cpaFiles.length))
})
const selectedReceivers = computed(() => {
  const selected = new Set(selectedReceiverIds.value)
  return (receiverData.value?.items || []).filter(receiver => selected.has(receiver.id) && (receiver.bindingCount === 0 || receiver.readyForDeletion))
})

function setVisibleSelection(target: 'accounts' | 'receivers', checked: boolean) {
  if (target === 'accounts') {
    const visible = new Set(selectableAccountRows.value.map(row => row.key))
    const next = new Set(selectedAccountKeys.value)
    visible.forEach(key => checked ? next.add(key) : next.delete(key))
    selectedAccountKeys.value = [...next]
    return
  }
  const visible = new Set(selectableReceivers.value.map(receiver => receiver.id))
  const next = new Set(selectedReceiverIds.value)
  visible.forEach(id => checked ? next.add(id) : next.delete(id))
  selectedReceiverIds.value = [...next]
}

function visibleSelectionState(target: 'accounts' | 'receivers') {
  const visible = target === 'accounts'
    ? selectableAccountRows.value.map(row => row.key)
    : selectableReceivers.value.map(receiver => receiver.id)
  const selected = new Set(target === 'accounts' ? selectedAccountKeys.value : selectedReceiverIds.value)
  const count = visible.filter(id => selected.has(id)).length
  return { all: visible.length > 0 && count === visible.length, some: count > 0 && count < visible.length }
}

const receiverSummary = computed(() => {
  const items = receiverData.value?.items || []
  return {
    total: items.length,
    available: items.filter(item => item.status === 'active').reduce((sum, item) => sum + item.availableSlots, 0)
  }
})

const receiverOptions = computed(() => (receiverData.value?.items || []).filter(item =>
  item.status === 'active' && (item.availableSlots > 0 || item.id === editing.value?.smsReceiver?.id)
))

const receiverImportPreview = computed(() => receiverImportText.value.split(/\r?\n/)
  .map((rawLine, index) => ({ rawLine: rawLine.trim(), line: index + 1 }))
  .filter(item => item.rawLine)
  .map(({ rawLine, line }) => {
    const separator = rawLine.indexOf('|')
    const phone = separator >= 0 ? rawLine.slice(0, separator).trim() : rawLine
    const fetchUrl = separator >= 0 ? rawLine.slice(separator + 1).trim() : ''
    const digits = phone.replace(/\D/g, '')
    const phoneValid = /^\+?[\d\s()-]+$/.test(phone) && digits.length >= 6 && digits.length <= 15
    let providerHost = ''
    try {
      const url = new URL(fetchUrl)
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) providerHost = url.hostname
    } catch { /* The server returns the detailed validation error. */ }
    return { line, phone: phone || '未填写手机号', providerHost, valid: separator >= 0 && phoneValid && Boolean(providerHost) }
  }))

const accountSourceLabels: Record<AccountVaultSource, string> = {
  ldxp: 'LDXP',
  nvtoken: 'NVToken',
  other: '其他',
  unknown: '未标注'
}
const deliveryFieldLabels: Record<AccountDeliveryField, string> = {
  email: '账号',
  password: '密码',
  totpSecret: '2FA 密钥',
  emailCodeUrl: '验证码地址',
  accessToken: 'AT',
  refreshToken: 'RT'
}
const deliveryFieldOptions = ACCOUNT_DELIVERY_FIELDS.map(value => ({ value, label: deliveryFieldLabels[value] }))
const deliveryConfigurationError = computed(() => {
  if (!deliveryFields.value.includes('email')) return '必须包含账号字段'
  if (deliveryFields.value.includes('accessToken') !== deliveryFields.value.includes('refreshToken')) return 'AT 和 RT 必须同时选择'
  return ''
})
const selectedDeliveryFormat = computed(() => ({
  label: deliveryFields.value.map(field => deliveryFieldLabels[field]).join(' + '),
  placeholder: deliveryFields.value.map(field => deliveryFieldLabels[field]).join('----'),
  fields: deliveryFields.value.length
}))
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
    const detailValid = validUrl && validTotp
    const valid = validEmail && validFields && detailValid
    return { index, email: validEmail ? values.email : '账号格式错误', kind: valid ? selected.label : '格式错误', valid }
  })
})

function sourceLabel(source?: AccountVaultSource | null) {
  return source ? accountSourceLabels[source] : '未标注'
}

function toggleDeliveryField(field: AccountDeliveryField) {
  if (field === 'email') return
  const current = deliveryFields.value
  deliveryFields.value = current.includes(field) ? current.filter(item => item !== field) : [...current, field]
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

function failure(value: unknown, fallback: string) {
  const error = value as { data?: { message?: string; statusMessage?: string }; message?: string }
  return error.data?.message || error.data?.statusMessage || error.message || fallback
}

function statusTone(status: string, schedulable = true) {
  if (!schedulable) return 'disabled'
  if (['active', 'success', 'Codex', '已登录'].includes(status)) return 'active'
  if (['pending', '仅Web', 'inactive'].includes(status)) return 'pending'
  return 'error'
}

function localizedStatus(status: string) {
  const labels: Record<string, string> = {
    active: '运行中',
    success: '运行中',
    pending: '待检测',
    inactive: '已停用',
    disabled: '已停用',
    error: '异常',
    unknown: '未知',
    Codex: 'Codex 已接入',
    '已登录': '已登录',
    '仅Web': '仅 Web',
    '已过期': '已过期',
    '已封禁': '已封禁',
    '接码失效': '接码失效'
  }
  return labels[status] || status || '未知'
}

function subAuthStatusCode(row: UnifiedAccountRow) {
  const probeCode = Number(row.quota?.probeError?.code)
  if (probeCode === 401 || probeCode === 403) return probeCode
  const detail = [row.sub?.errorMessage, row.quota?.error, row.quota?.probeError?.message].filter(Boolean).join(' ')
  const explicitCode = detail.match(/\b(401|403)\b/)?.[1]
  if (explicitCode) return Number(explicitCode)
  if (/token\s+revoked|invalid(?:ated)?\s+(?:oauth|token)|unauthori[sz]ed/i.test(detail)) return 401
  return null
}

function subHasAuthFailure(row: UnifiedAccountRow) {
  return subAuthStatusCode(row) !== null
}

function subIsRateLimited(row: UnifiedAccountRow) {
  return Boolean(row.quota?.windows.some((windowItem) => {
    if (windowItem.remainingPercent !== null) return windowItem.remainingPercent <= 0
    return windowItem.used !== null && windowItem.limit !== null && windowItem.limit > 0 && windowItem.used >= windowItem.limit
  }))
}

function subStatusLabel(row: UnifiedAccountRow) {
  if (!row.sub) return ''
  if (subAuthStatusCode(row)) return '认证失效'
  if (row.quota?.quotaStatus === 'error') return '检测失败'
  if (subIsRateLimited(row)) return '已限流'
  return localizedStatus(row.sub.status)
}

function subStatusTone(row: UnifiedAccountRow) {
  if (subHasAuthFailure(row) || row.quota?.quotaStatus === 'error') return 'error'
  if (subIsRateLimited(row)) return 'pending'
  return statusTone(row.sub?.status || 'unknown')
}

function accountSortRank(row: UnifiedAccountRow) {
  if (subHasAuthFailure(row)) return 4
  if (subIsRateLimited(row)) return 3
  if (row.quota?.quotaStatus === 'error' || row.sub?.errorMessage) return 2
  if (row.sub && (!row.sub.schedulable || /^(?:inactive|disabled|error|failed|unavailable)$/i.test(row.sub.status))) return 2
  if (row.cpaFiles.length && row.cpaFiles.every(item => item.disabled)) return 2
  if (row.vault && ['已过期', '已封禁', '接码失效'].includes(row.vault.status)) return 2
  return 0
}

function accountSortTime(row: UnifiedAccountRow) {
  return row.vault?.createdAt
    || row.sub?.updatedAt
    || Math.max(0, ...row.cpaFiles.map(item => item.lastRefreshAt || 0))
}

function localSmsStatus(item: AccountVaultView) {
  if (!item.smsReceiver) return '未分配接码'
  return item.smsVerifiedAt ? '已接码' : '未接码'
}

function localSmsTone(item: AccountVaultView) {
  if (!item.smsReceiver) return 'neutral'
  return item.smsVerifiedAt ? 'active' : 'neutral'
}

function localPoolStatus(row: UnifiedAccountRow) {
  if (row.sub || row.subPoolStatus === 'active') return '已登录'
  if (row.subPoolStatus === 'deleted') return 'SUB 已删除'
  return '未进入 SUB 号池'
}

function localPoolTone(row: UnifiedAccountRow) {
  if (row.subPoolStatus === 'deleted') return 'error'
  if (row.sub || row.subPoolStatus === 'active') return 'active'
  return 'neutral'
}

function time(value: number | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(value) : '—'
}

function formatQuotaValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)
}

function formatCompactUsage(value: number) {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(value)
}

function formatUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2
  }).format(value)
}

function smsMessageSummary(result: SmsCodeResult) {
  return result.message.split('|', 1)[0]?.trim() || '暂无新验证码'
}

function accountEmail(row: UnifiedAccountRow) {
  return row.vault?.email
    || row.sub?.email
    || row.cpaFiles[0]?.account
    || row.sub?.name
    || row.cpaFiles[0]?.name.replace(/\.json$/i, '')
    || '未命名账号'
}

function accountPlan(row: UnifiedAccountRow) {
  return row.quota?.planType || row.cpaFiles.find(item => item.planType)?.planType || ''
}

function accountTypeLabel(row: UnifiedAccountRow) {
  if (row.sub) return ''
  if (row.cpaFiles.length) return `${row.cpaFiles[0]?.provider || '未知服务'} / 认证文件`
  if (row.vault?.credentialKind === 'tokens') return 'AT / RT'
  if (row.vault?.credentialKind === 'email_code_url') return '邮箱链接'
  if (row.vault?.hasTotpSecret) return '密码 + 2FA'
  return '密码'
}

function belongsToSub(row: UnifiedAccountRow) {
  return Boolean(row.sub || row.subPoolStatus === 'active' || row.subPoolStatus === 'deleted')
}

async function loadAccountPasswords() {
  try {
    const result = await $fetch<{ items: Array<{ id: string; password: string }> }>('/api/admin/account-vault/passwords', { method: 'POST' })
    Object.keys(accountPasswords).forEach(id => delete accountPasswords[id])
    result.items.forEach((item) => { accountPasswords[item.id] = item.password })
  } catch (value) {
    showToast(failure(value, '读取账号密码失败'), 'error')
  }
}

async function refreshAllData(includeQuota = true) {
  loadingAll.value = true
  try {
    const tasks: Promise<unknown>[] = [refreshVault(), refreshReceivers(), refreshManaged(), refreshCpa(), refreshGroups(), refreshProxies(), loadAccountPasswords()]
    if (includeQuota) tasks.push(refreshQuotas())
    await Promise.all(tasks)
  } finally {
    loadingAll.value = false
  }
}

function resetUploadForm() {
  cpaUploadFiles.value = []
  cpaUploadError.value = ''
  importText.value = ''
  importFileName.value = ''
  importRows.value = []
  importError.value = ''
  importSchedulable.value = true
  importAdvancedRaw.value = false
}

function resetConversionForm() {
  conversionInput.value = ''
  conversionRows.value = []
  conversionSkipped.value = []
  conversionFileCount.value = 0
  conversionError.value = ''
  Object.assign(conversionConfig, {
    groupIds: defaultCodexGroups(),
    proxyId: proxyData.value?.defaultProxyId || null,
    concurrency: 10,
    priority: 0,
    rateMultiplier: 1,
    schedulable: true
  })
}

function applyConversionResult(accounts: ConvertedCredentialAccount[], skipped: SkippedCredentialSource[], fileCount: number) {
  conversionRows.value = accounts.map(item => ({
    ...item,
    selected: true,
    targets: ['sub2api'],
    cpaState: 'idle',
    cpaError: null,
    sub2apiState: 'idle',
    sub2apiError: null
  }))
  conversionSkipped.value = skipped
  conversionFileCount.value = fileCount
  conversionError.value = accounts.length ? '' : skipped.map(item => `${item.sourceName}：${item.message}`).join('\n') || '没有识别到可转换账号'
}

function parseConversionInput() {
  const text = conversionInput.value
  conversionError.value = ''
  try {
    const result = convertCredentialSourceText(text)
    applyConversionResult(result.accounts, result.skipped, 1)
  } catch (value) {
    conversionRows.value = []
    conversionSkipped.value = []
    conversionError.value = failure(value, '凭据转换失败')
  } finally {
    conversionInput.value = ''
  }
}

async function readConversionFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || []).filter(file => file.name.toLowerCase().endsWith('.json'))
  conversionError.value = ''
  try {
    if (!files.length) throw new Error('请选择 JSON 文件')
    if (files.length > 20) throw new Error('单次最多选择 20 个 JSON 文件')
    const documents: CredentialSourceDocument[] = []
    const skipped: SkippedCredentialSource[] = []
    for (const file of files) {
      try {
        documents.push(parseCredentialSourceText(await file.text(), file.name))
      } catch (value) {
        skipped.push({ sourceName: file.name, sourcePath: '$', message: failure(value, '文件解析失败') })
      }
    }
    if (!documents.length) {
      applyConversionResult([], skipped, files.length)
      return
    }
    const result = convertCredentialDocuments(documents)
    applyConversionResult(result.accounts, [...skipped, ...result.skipped], files.length)
  } catch (value) {
    conversionRows.value = []
    conversionSkipped.value = []
    conversionError.value = failure(value, '读取凭据文件失败')
  } finally {
    input.value = ''
  }
}

function conversionSourceLabel(value: string) {
  return {
    chatgpt_web_session: 'ChatGPT Session',
    codex_auth: 'Codex auth.json',
    codex_manager: 'Codex Manager',
    sub2api: 'Sub2API',
    cpa: 'CPA',
    '9router': '9router'
  }[value] || '其他凭据'
}

function conversionTargetStatus(item: ConversionAccountRow, target: CredentialImportTarget) {
  const state = target === 'cpa' ? item.cpaState : item.sub2apiState
  return { idle: '', loading: '导入中', success: '已导入', error: '失败' }[state]
}

function conversionCpaFiles(rows: ConversionAccountRow[]) {
  const used = new Map<string, number>()
  return rows.map((row) => {
    const base = cpaCredentialFileName(row)
    const count = (used.get(base) || 0) + 1
    used.set(base, count)
    const name = count === 1 ? base : base.replace(/\.json$/i, `-${count}.json`)
    return { row, name }
  })
}

async function importConvertedCredentials() {
  conversionError.value = ''
  const selected = selectedConversionRows.value
  if (!selected.length) {
    conversionError.value = '请至少选择一个账号'
    return
  }
  if (selected.some(item => !item.targets.length)) {
    conversionError.value = '每个选中账号至少需要一个导入目标'
    return
  }
  const cpaRows = selected.filter(item => item.targets.includes('cpa') && item.cpaState !== 'success')
  const subRows = selected.filter(item => item.targets.includes('sub2api') && item.sub2apiState !== 'success')
  if (cpaRows.length > 20) {
    conversionError.value = 'CPA 单次最多导入 20 个账号'
    return
  }
  if (subRows.length > 100) {
    conversionError.value = 'Sub2API 单次最多导入 100 个账号'
    return
  }
  conversionSaving.value = true
  const failures: string[] = []
  try {
    if (cpaRows.length) {
      cpaRows.forEach((item) => { item.cpaState = 'loading'; item.cpaError = null })
      const files = conversionCpaFiles(cpaRows)
      try {
        const body = new FormData()
        files.forEach(({ row, name }) => body.append('files', new File([JSON.stringify(row.cpaCredential)], name, { type: 'application/json' })))
        const result = await $fetch<{ files: CpaAuthFileView[]; failed: Array<{ name: string; error: string }> }>('/api/admin/upstreams/cpa/auth-files', { method: 'POST', body })
        const failedByName = new Map(result.failed.map(item => [item.name, item.error]))
        files.forEach(({ row, name }) => {
          const message = failedByName.get(name)
          row.cpaState = message ? 'error' : 'success'
          row.cpaError = message || null
          if (message) failures.push(`${row.email || row.name} / CPA：${message}`)
        })
      } catch (value) {
        const message = failure(value, 'CPA 导入失败')
        cpaRows.forEach((item) => { item.cpaState = 'error'; item.cpaError = message })
        failures.push(`CPA：${message}`)
      }
    }
    if (subRows.length) {
      subRows.forEach((item) => { item.sub2apiState = 'loading'; item.sub2apiError = null })
      try {
        const result = await $fetch<{ created: unknown[]; failed: Array<{ index: number; name: string; error: string }> }>('/api/admin/upstreams/sub/accounts/import', {
          method: 'POST',
          body: {
            accounts: subRows.map(item => ({
              name: item.name,
              email: item.email,
              platform: 'openai',
              type: 'oauth',
              credentials: item.sub2apiCredentials,
              extra: item.sub2apiExtra,
              concurrency: conversionConfig.concurrency,
              priority: conversionConfig.priority,
              rateMultiplier: conversionConfig.rateMultiplier,
              groupIds: conversionConfig.groupIds,
              proxyId: conversionConfig.proxyId,
              expiresAt: item.accessTokenExpiresAt ? item.accessTokenExpiresAt * 1000 : null
            })),
            schedulable: conversionConfig.schedulable,
            advancedRaw: false
          }
        })
        const failedByIndex = new Map(result.failed.map(item => [item.index, item.error]))
        subRows.forEach((item, index) => {
          const message = failedByIndex.get(index)
          item.sub2apiState = message ? 'error' : 'success'
          item.sub2apiError = message || null
          if (message) failures.push(`${item.email || item.name} / Sub2API：${message}`)
        })
      } catch (value) {
        const message = failure(value, 'Sub2API 导入失败')
        subRows.forEach((item) => { item.sub2apiState = 'error'; item.sub2apiError = message })
        failures.push(`Sub2API：${message}`)
      }
    }
    await refreshAllData()
    if (failures.length) {
      conversionError.value = failures.slice(0, 8).join('\n')
      showToast(`转换导入完成，${failures.length} 项失败`, 'info')
      return
    }
    const imported = selected.length
    resetConversionForm()
    showForm.value = false
    showToast(`已转换并导入 ${imported} 个账号`, 'success')
  } finally {
    conversionSaving.value = false
  }
}

function selectCpaFiles(event: Event) {
  cpaUploadFiles.value = Array.from((event.target as HTMLInputElement).files || [])
}

async function uploadCpaFiles() {
  if (!cpaUploadFiles.value.length) {
    cpaUploadError.value = '请选择认证 JSON 文件'
    return
  }
  cpaUploadSaving.value = true
  cpaUploadError.value = ''
  try {
    const body = new FormData()
    cpaUploadFiles.value.forEach(file => body.append('files', file))
    const result = await $fetch<{ files: CpaAuthFileView[]; failed: Array<{ name: string; error: string }> }>('/api/admin/upstreams/cpa/auth-files', {
      method: 'POST', body
    })
    await refreshCpa()
    if (result.failed.length) {
      cpaUploadError.value = result.failed.slice(0, 5).map(item => `${item.name}：${item.error}`).join('\n')
      showToast(`CPA 上传完成：成功 ${result.files.length}，失败 ${result.failed.length}`, 'info')
      return
    }
    showForm.value = false
    showToast(`已上传 ${result.files.length} 个 CPA 认证文件`, 'success')
  } catch (value) {
    cpaUploadError.value = failure(value, 'CPA 认证文件上传失败')
  } finally {
    cpaUploadSaving.value = false
  }
}

async function verifyCpa(item: CpaAuthFileView) {
  cpaMutating[item.id] = true
  try {
    const result = await $fetch<{ modelCount: number }>(`/api/admin/upstreams/cpa/auth-files/${item.id}/verify`, { method: 'POST' })
    await refreshCpa()
    showToast(`CPA 验活通过，可用模型 ${result.modelCount} 个`, 'success')
  } catch (value) {
    showToast(failure(value, 'CPA 认证文件验活失败'), 'error')
  } finally {
    cpaMutating[item.id] = false
  }
}

async function toggleCpa(item: CpaAuthFileView) {
  cpaMutating[item.id] = true
  try {
    await $fetch(`/api/admin/upstreams/cpa/auth-files/${item.id}`, {
      method: 'PATCH', body: { disabled: !item.disabled }
    })
    await refreshCpa()
    showToast(item.disabled ? 'CPA 认证文件已启用' : 'CPA 认证文件已停用', 'success')
  } catch (value) {
    showToast(failure(value, '修改 CPA 认证文件状态失败'), 'error')
  } finally {
    cpaMutating[item.id] = false
  }
}

async function copyText(value: string, message: string) {
  if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value)
  else {
    const input = document.createElement('textarea')
    input.value = value
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  showToast(message, 'success')
}

function resetForm() {
  Object.assign(form, {
    email: '', displayName: '', source: '', status: 'Codex', password: '', emailCodeUrl: '', totpSecret: '', smsReceiverId: '', remark: ''
  })
  emailCodeUrlTouched.value = false
  totpSecretTouched.value = false
  formError.value = ''
}

function openCreate() {
  editing.value = null
  accountCreateMode.value = 'manual'
  uploadPool.value = 'sub2api'
  resetForm()
  resetUploadForm()
  resetConversionForm()
  deliveryText.value = ''
  deliveryFields.value = ['email', 'password']
  deliverySource.value = ''
  deliveryError.value = ''
  showForm.value = true
}

function openEdit(item: AccountVaultView) {
  editing.value = item
  Object.assign(form, {
    email: item.email,
    displayName: item.displayName || '',
    source: item.source,
    status: item.status,
    password: '',
    emailCodeUrl: '',
    totpSecret: '',
    smsReceiverId: item.smsReceiver?.id || '',
    remark: item.remark || ''
  })
  emailCodeUrlTouched.value = false
  totpSecretTouched.value = false
  formError.value = ''
  accountCreateMode.value = 'manual'
  showForm.value = true
}

function closeForm() {
  if (saving.value || deliveryImporting.value || importSaving.value || cpaUploadSaving.value || conversionSaving.value) return
  showForm.value = false
}

async function saveVault() {
  saving.value = true
  formError.value = ''
  try {
    const body: Record<string, unknown> = {
      email: form.email,
      displayName: form.displayName,
      source: form.source,
      status: form.status,
      password: form.password || undefined,
      smsReceiverId: form.smsReceiverId || null,
      remark: form.remark
    }
    if (!editing.value || emailCodeUrlTouched.value) body.emailCodeUrl = form.emailCodeUrl
    if (!editing.value || totpSecretTouched.value) body.totpSecret = form.totpSecret
    if (editing.value) await $fetch(`/api/admin/account-vault/${editing.value.id}`, { method: 'PATCH', body })
    else await $fetch('/api/admin/account-vault', { method: 'POST', body })
    await refreshAllData(false)
    showForm.value = false
    showToast(editing.value ? '账号资料已更新' : '账号已创建', 'success')
  } catch (value) {
    formError.value = failure(value, '保存账号失败')
  } finally {
    saving.value = false
  }
}

async function importDelivery() {
  deliveryError.value = ''
  if (!deliverySource.value) {
    deliveryError.value = '请选择账号来源'
    return
  }
  if (deliveryConfigurationError.value) {
    deliveryError.value = deliveryConfigurationError.value
    return
  }
  if (!deliveryPreview.value.length) {
    deliveryError.value = '请输入发货内容'
    return
  }
  deliveryImporting.value = true
  try {
    const result = await $fetch<{ created: number; skipped: number; failed: Array<{ index: number; email: string; message: string }> }>('/api/admin/account-vault/delivery-import', {
      method: 'POST', body: { text: deliveryText.value, fields: deliveryFields.value, source: deliverySource.value }
    })
    await refreshAllData(false)
    if (result.failed.length) {
      deliveryError.value = result.failed.slice(0, 5)
        .map(item => `第 ${item.index + 1} 行${item.email ? `（${item.email}）` : ''}：${item.message}`).join('\n')
      showToast(`导入完成：新增 ${result.created}，跳过 ${result.skipped}，失败 ${result.failed.length}`, 'info')
      return
    }
    showForm.value = false
    deliveryText.value = ''
    showToast(`发货账号已导入：新增 ${result.created}，跳过 ${result.skipped}`, 'success')
  } catch (value) {
    deliveryError.value = failure(value, '发货账号导入失败')
  } finally {
    deliveryImporting.value = false
  }
}

function openExport() {
  exportPassword.value = ''
  exportError.value = ''
  showExport.value = true
}

async function exportAccounts() {
  exportError.value = ''
  if (!exportPassword.value) return
  try {
    const response = await fetch('/api/admin/account-vault/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: exportPassword.value })
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message || body?.statusMessage || '导出失败')
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `account-vault-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    showExport.value = false
    showToast('完整账号 JSON 已安全导出', 'success')
  } catch (value) {
    exportError.value = failure(value, '导出账号失败')
  }
}

async function refreshAccountSmsCode(item: AccountVaultView) {
  if (refreshingAccountCodes[item.id]) return
  refreshingAccountCodes[item.id] = true
  try {
    const response = await $fetch<{ result: SmsCodeResult }>(`/api/admin/account-vault/${item.id}/sms/refresh`, { method: 'POST' })
    accountSmsCodes[item.id] = response.result
    await Promise.all([refreshVault(), refreshReceivers()])
    showToast(response.result.code ? '已获取新的短信验证码' : response.result.message, response.result.code ? 'success' : 'info')
  } catch (value) {
    showToast(failure(value, '刷新短信验证码失败'), 'error')
  } finally {
    refreshingAccountCodes[item.id] = false
  }
}

async function generateAccountTotp(item: AccountVaultView) {
  if (generatingTotp[item.id]) return
  generatingTotp[item.id] = true
  try {
    const response = await $fetch<{ result: AccountTotpCodeResult }>(`/api/admin/account-vault/${item.id}/totp`, { method: 'POST' })
    accountTotpCodes[item.id] = response.result
    window.clearTimeout(totpTimers.get(item.id))
    totpTimers.set(item.id, window.setTimeout(() => {
      delete accountTotpCodes[item.id]
      totpTimers.delete(item.id)
    }, Math.max(0, response.result.expiresAt - Date.now())))
    showToast('2FA 动态验证码已生成', 'success')
  } catch (value) {
    showToast(failure(value, '生成 2FA 动态验证码失败'), 'error')
  } finally {
    generatingTotp[item.id] = false
  }
}

function defaultCodexGroups() {
  const exact = groups.value.find(item => item.status === 'active' && item.name.trim().toLowerCase() === 'codex')
  const partial = groups.value.find(item => item.status === 'active' && item.name.toLowerCase().includes('codex'))
  return exact || partial ? [(exact || partial)!.id] : []
}

function activeProxies() {
  return proxies.value.filter(item => item.status === 'active' && (!item.expiresAt || item.expiresAt > Date.now()))
}

function openOAuth(item: AccountVaultView) {
  oauthAccount.value = item
  Object.assign(oauthForm, {
    name: item.email,
    concurrency: 10,
    priority: 0,
    groupIds: defaultCodexGroups(),
    proxyId: proxyData.value?.defaultProxyId || null,
    schedulable: true,
    authorizationUrl: '',
    flowId: '',
    callbackUrl: '',
    expiresAt: null
  })
  oauthError.value = ''
}

async function startOAuth() {
  if (!oauthAccount.value) return
  oauthSaving.value = true
  oauthError.value = ''
  try {
    const result = await $fetch<{ authorizationUrl: string; flowId: string; expiresAt: number }>('/api/admin/upstreams/sub/accounts/oauth/start', {
      method: 'POST',
      body: { accountVaultId: oauthAccount.value.id, proxyId: oauthForm.proxyId }
    })
    oauthForm.authorizationUrl = result.authorizationUrl
    oauthForm.flowId = result.flowId
    oauthForm.expiresAt = result.expiresAt
  } catch (value) {
    oauthError.value = failure(value, '生成 OpenAI 授权链接失败')
  } finally {
    oauthSaving.value = false
  }
}

function restartOAuth() {
  oauthForm.authorizationUrl = ''
  oauthForm.flowId = ''
  oauthForm.callbackUrl = ''
  oauthForm.expiresAt = null
  oauthError.value = ''
}

async function completeOAuth() {
  if (!oauthAccount.value || !oauthForm.flowId || !oauthForm.callbackUrl.trim()) return
  oauthSaving.value = true
  oauthError.value = ''
  try {
    await $fetch('/api/admin/upstreams/sub/accounts/oauth/complete', {
      method: 'POST',
      body: {
        accountVaultId: oauthAccount.value.id,
        flowId: oauthForm.flowId,
        callbackUrl: oauthForm.callbackUrl,
        name: oauthForm.name,
        concurrency: oauthForm.concurrency,
        priority: oauthForm.priority,
        groupIds: oauthForm.groupIds,
        schedulable: oauthForm.schedulable
      }
    })
    oauthAccount.value = null
    await refreshAllData()
    showToast('账号已授权并添加到 Codex 号池', 'success')
  } catch (value) {
    oauthError.value = failure(value, '完成 OpenAI 授权失败')
  } finally {
    oauthSaving.value = false
  }
}

async function toggleSubScheduling(item: SubAccountManagementView, schedulable: boolean) {
  subMutating[item.id] = true
  try {
    await $fetch(`/api/admin/upstreams/sub/accounts/${item.id}`, { method: 'PATCH', body: { schedulable } })
    await refreshManaged()
    showToast(schedulable ? '账号调度已启用' : '账号调度已暂停', 'success')
  } catch (value) {
    showToast(failure(value, '修改调度状态失败'), 'error')
    await refreshManaged()
  } finally {
    subMutating[item.id] = false
  }
}

async function verifySub(item: SubAccountManagementView) {
  subMutating[item.id] = true
  try {
    await $fetch(`/api/admin/upstreams/sub/accounts/${item.id}/verify`, { method: 'POST', body: { activate: false } })
    await Promise.all([refreshManaged(), refreshQuotas()])
    showToast('账号验证通过', 'success')
  } catch (value) {
    showToast(failure(value, '账号验活失败'), 'error')
    await refreshManaged()
  } finally {
    subMutating[item.id] = false
  }
}

async function refreshQuota(item: SubAccountManagementView) {
  quotaRefreshing[item.id] = true
  try {
    const result = await $fetch<Sub2ApiAccountQuotaResult>(`/api/sub2api/${item.id}/refresh`, { method: 'POST' })
    await Promise.all([refreshManaged(), refreshQuotas()])
    if (result.probeError || result.quotaStatus === 'error') {
      showToast(result.probeError?.message || result.error || '账号检测失败', 'error')
    } else {
      showToast('账号状态与用量窗口已刷新', 'success')
    }
  } catch (value) {
    showToast(failure(value, '刷新用量失败'), 'error')
    await Promise.allSettled([refreshManaged(), refreshQuotas()])
  } finally {
    quotaRefreshing[item.id] = false
  }
}

function openSubEdit(item: SubAccountManagementView) {
  editingSub.value = item
  Object.assign(subForm, {
    name: item.name,
    notes: item.notes || '',
    concurrency: item.concurrency,
    priority: item.priority,
    rateMultiplier: item.rateMultiplier,
    groupIds: [...item.groupIds],
    proxyId: item.proxyId,
    status: item.status,
    schedulable: item.schedulable
  })
  subFormError.value = ''
}

async function saveSub() {
  if (!editingSub.value) return
  saving.value = true
  subFormError.value = ''
  try {
    await $fetch(`/api/admin/upstreams/sub/accounts/${editingSub.value.id}`, { method: 'PATCH', body: subForm })
    editingSub.value = null
    await Promise.all([refreshManaged(), refreshGroups(), refreshProxies()])
    showToast('Sub2API 账号配置已更新', 'success')
  } catch (value) {
    subFormError.value = failure(value, '保存 Sub2API 账号失败')
  } finally {
    saving.value = false
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function jwtClaims(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  const payload = value.split('.')[1]
  if (!payload) return {}
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    return objectValue(JSON.parse(atob(normalized))) || {}
  } catch {
    return {}
  }
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

function parseImportText(text: string) {
  importError.value = ''
  let root: Record<string, unknown>
  try {
    const parsed = JSON.parse(text)
    const record = objectValue(parsed) || (Array.isArray(parsed) ? { accounts: parsed } : null)
    if (!record) throw new Error('invalid root')
    root = record
  } catch {
    importRows.value = []
    importError.value = '文件不是有效的 JSON 对象'
    return
  }
  const sourceAccounts = Array.isArray(root.accounts)
    ? root.accounts
    : root.credentials && objectValue(root.credentials) ? [root] : [{ credentials: root }]
  const defaultGroups = defaultCodexGroups()
  importRows.value = sourceAccounts.map((value, index) => {
    const account = objectValue(value) || {}
    const credentials = objectValue(account.credentials) || (index === 0 && sourceAccounts.length === 1 ? root : {})
    const extra = objectValue(account.extra) || {}
    const profile = credentialIdentity(credentials)
    const email = String(account.email || extra.email || profile.email || '').trim() || null
    const name = String(account.name || extra.name || profile.name || email || `导入账号 ${index + 1}`).trim()
    return {
      key: `${index}:${name}`,
      name,
      email,
      platform: String(account.platform || 'openai'),
      type: String(account.type || (credentials.refresh_token || credentials.access_token ? 'oauth' : 'apikey')),
      credentials,
      extra,
      concurrency: Number(account.concurrency) > 0 ? Number(account.concurrency) : 10,
      priority: Number(account.priority) >= 0 ? Number(account.priority) : 0,
      rateMultiplier: Number(account.rate_multiplier) >= 0 ? Number(account.rate_multiplier) : 1,
      groupIds: [...defaultGroups],
      proxyId: proxyData.value?.defaultProxyId || null
    }
  })
  if (!importRows.value.length) importError.value = 'JSON 中没有可导入的账号'
}

async function readImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importFileName.value = file.name
  importText.value = await file.text()
  parseImportText(importText.value)
}

async function importSubAccounts() {
  if (!importRows.value.length) parseImportText(importText.value)
  if (!importRows.value.length) return
  importSaving.value = true
  importError.value = ''
  try {
    const result = await $fetch<{ created: unknown[]; failed: Array<{ name: string; error: string }> }>('/api/admin/upstreams/sub/accounts/import', {
      method: 'POST',
      body: { accounts: importRows.value, schedulable: importSchedulable.value, advancedRaw: importAdvancedRaw.value }
    })
    await refreshAllData()
    if (result.failed.length) {
      importError.value = result.failed.slice(0, 5).map(item => `${item.name}：${item.error}`).join('\n')
      showToast(`Sub2API 导入完成：成功 ${result.created.length}，失败 ${result.failed.length}`, 'info')
      return
    }
    showForm.value = false
    showToast(`已导入 ${result.created.length} 个账号并加入号池`, 'success')
  } catch (value) {
    importError.value = failure(value, 'Sub2API 账号导入失败')
  } finally {
    importSaving.value = false
  }
}

async function uploadSelectedPool() {
  if (uploadPool.value === 'cpa') await uploadCpaFiles()
  else await importSubAccounts()
}

function openReceiverCreate() {
  editingReceiver.value = null
  Object.assign(receiverForm, { phone: '', fetchUrl: '', note: '', active: true })
  receiverCreateMode.value = 'single'
  receiverImportText.value = ''
  receiverError.value = ''
  manualBindingError.value = ''
  showReceiverForm.value = true
}

function openReceiverEdit(item: SmsReceiverView) {
  editingReceiver.value = item
  Object.assign(receiverForm, { phone: item.phone, fetchUrl: '', note: item.note || '', active: item.status === 'active' })
  receiverError.value = ''
  Object.assign(manualBindingForm, { email: '', displayName: '' })
  manualBindingError.value = ''
  showReceiverForm.value = true
}

function closeReceiverForm() {
  if (receiverSaving.value) return
  showReceiverForm.value = false
  editingReceiver.value = null
  receiverImportText.value = ''
  receiverError.value = ''
  Object.assign(manualBindingForm, { email: '', displayName: '' })
  manualBindingError.value = ''
}

async function addManualBinding() {
  const receiverId = editingReceiver.value?.id
  if (!receiverId || manualBindingSaving.value) return
  manualBindingSaving.value = true
  manualBindingError.value = ''
  try {
    const response = await $fetch<{ item?: SmsReceiverView }>(`/api/admin/sms-receivers/${receiverId}/bindings`, {
      method: 'POST',
      body: { email: manualBindingForm.email, displayName: manualBindingForm.displayName }
    })
    await Promise.all([refreshReceivers(), refreshVault()])
    editingReceiver.value = response.item || receiverData.value?.items.find(item => item.id === receiverId) || editingReceiver.value
    Object.assign(manualBindingForm, { email: '', displayName: '' })
    showToast('已添加手动占用', 'success')
  } catch (value) {
    manualBindingError.value = failure(value, '添加手动占用失败')
  } finally {
    manualBindingSaving.value = false
  }
}

async function saveReceiver() {
  if (!editingReceiver.value && receiverCreateMode.value === 'batch') {
    receiverSaving.value = true
    receiverError.value = ''
    const sourceLines = receiverImportText.value.split(/\r?\n/)
    try {
      const result = await $fetch<SmsReceiverImportResult>('/api/admin/sms-receivers/import', {
        method: 'POST', body: { text: receiverImportText.value }
      })
      if (result.created.length) await Promise.all([refreshReceivers(), refreshVault()])
      if (result.failed.length) {
        const failedLines = new Set(result.failed.map(item => item.line))
        receiverImportText.value = sourceLines.filter((_line, index) => failedLines.has(index + 1)).join('\n')
        const messages = result.failed.slice(0, 20).map(item => `第 ${item.line} 行${item.phone ? `（${item.phone}）` : ''}：${item.error}`)
        if (result.failed.length > messages.length) messages.push(`另有 ${result.failed.length - messages.length} 行导入失败`)
        receiverError.value = messages.join('\n')
        const summary = `成功 ${result.created.length} 个，跳过 ${result.skipped.length} 个，失败 ${result.failed.length} 个`
        showToast(summary, result.created.length ? 'success' : 'error')
      } else {
        showReceiverForm.value = false
        receiverImportText.value = ''
        const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 个重复号码` : ''
        showToast(`已导入 ${result.created.length} 个接码${skipped}`, 'success')
      }
    } catch (value) {
      receiverError.value = failure(value, '批量导入接码失败')
    } finally {
      receiverSaving.value = false
    }
    return
  }
  const wasEditing = Boolean(editingReceiver.value)
  receiverSaving.value = true
  receiverError.value = ''
  try {
    const body = {
      phone: receiverForm.phone,
      note: receiverForm.note,
      status: receiverForm.active ? 'active' : 'disabled',
      ...(receiverForm.fetchUrl ? { fetchUrl: receiverForm.fetchUrl } : {})
    }
    if (editingReceiver.value) await $fetch(`/api/admin/sms-receivers/${editingReceiver.value.id}`, { method: 'PATCH', body })
    else await $fetch('/api/admin/sms-receivers', { method: 'POST', body })
    await Promise.all([refreshReceivers(), refreshVault()])
    showReceiverForm.value = false
    editingReceiver.value = null
    showToast(wasEditing ? '接码资源已更新' : '接码资源已创建', 'success')
  } catch (value) {
    receiverError.value = failure(value, '保存接码资源失败')
  } finally {
    receiverSaving.value = false
  }
}

async function toggleReceiver(item: SmsReceiverView, active: boolean) {
  receiverMutating[item.id] = true
  try {
    await $fetch(`/api/admin/sms-receivers/${item.id}`, { method: 'PATCH', body: { status: active ? 'active' : 'disabled' } })
    await refreshReceivers()
    showToast(active ? '接码资源已启用' : '接码资源已停用', 'success')
  } catch (value) {
    showToast(failure(value, '修改接码状态失败'), 'error')
    await refreshReceivers()
  } finally {
    receiverMutating[item.id] = false
  }
}

async function refreshSmsCode(receiverId: string) {
  refreshingCodes[receiverId] = true
  try {
    const response = await $fetch<{ result: SmsCodeResult }>(`/api/admin/sms-receivers/${receiverId}/refresh`, { method: 'POST' })
    smsCodes[receiverId] = response.result
    await Promise.all([refreshReceivers(), refreshVault()])
    showToast(response.result.code ? '已获取新的短信验证码' : response.result.message, response.result.code ? 'success' : 'info')
  } catch (value) {
    showToast(failure(value, '刷新短信验证码失败'), 'error')
  } finally {
    refreshingCodes[receiverId] = false
  }
}

function deleteMessage(target: DeleteTarget | null) {
  if (!target) return ''
  if (target.kind === 'bulk-accounts') return `删除选中的 ${target.items.length} 个账号？本地账号会保留接码历史名额，Sub2API 账号只有当前并发为 0 时才会删除。`
  if (target.kind === 'bulk-receivers') return `永久删除选中的 ${target.items.length} 个接码手机号？标记为可删除的号码会同时清理历史绑定。`
  if (target.kind === 'vault') return `删除本地账号“${target.item.email}”？已进入 Sub2API 的账号不会随之删除，接码历史名额会保留。`
  if (target.kind === 'sub') return `永久删除 Sub2API 账号“${target.item.name}”？只有当前并发为 0 时才会执行。`
  if (target.kind === 'cpa') return `永久删除 CPA 认证文件“${target.item.name}”？删除前必须先停用，此操作无法恢复。`
  if (target.kind === 'receiver') return target.item.readyForDeletion
    ? `永久删除接码手机号“${target.item.phone}”及其 3 条已删除账号绑定记录？`
    : `永久删除接码手机号“${target.item.phone}”？`
  return target.account.deleted
    ? `释放手机号为已删除账号“${target.account.email}”保留的名额？`
    : target.account.manual
      ? `解除手机号为“${target.account.email}”保留的手动占用？`
    : `解除账号“${target.account.email}”与手机号“${target.receiver.phone}”的绑定？`
}

async function confirmDelete() {
  const target = deleting.value
  if (!target) return
  deletingBusy.value = true
  try {
    if (target.kind === 'bulk-accounts') {
      const failed: string[] = []
      for (const row of target.items) {
        try {
          if (row.vault) {
            await $fetch(`/api/admin/account-vault/${row.vault.id}`, { method: 'DELETE' })
            delete accountPasswords[row.vault.id]
            delete accountTotpCodes[row.vault.id]
            window.clearTimeout(totpTimers.get(row.vault.id))
          } else if (row.sub) {
            await $fetch(`/api/admin/upstreams/sub/accounts/${row.sub.id}`, {
              method: 'DELETE', headers: { 'idempotency-key': clientRandomUUID() }
            })
          } else {
            for (const item of row.cpaFiles) {
              await $fetch(`/api/admin/upstreams/cpa/auth-files/${item.id}`, {
                method: 'DELETE', headers: { 'idempotency-key': clientRandomUUID() }
              })
            }
          }
        } catch { failed.push(row.key) }
      }
      selectedAccountKeys.value = failed
      await Promise.all([refreshVault(), refreshReceivers(), refreshManaged(), refreshQuotas(), refreshCpa()])
      deleting.value = null
      if (failed.length) showToast(`已删除 ${target.items.length - failed.length} 个，${failed.length} 个删除失败`, 'error')
      else showToast(`已删除 ${target.items.length} 个账号`, 'success')
      return
    } else if (target.kind === 'bulk-receivers') {
      const failed: string[] = []
      for (const receiver of target.items) {
        try { await $fetch(`/api/admin/sms-receivers/${receiver.id}`, { method: 'DELETE' }) } catch { failed.push(receiver.id) }
      }
      selectedReceiverIds.value = failed
      await refreshReceivers()
      deleting.value = null
      if (failed.length) showToast(`已删除 ${target.items.length - failed.length} 个，${failed.length} 个删除失败`, 'error')
      else showToast(`已删除 ${target.items.length} 个接码`, 'success')
      return
    } else if (target.kind === 'vault') {
      await $fetch(`/api/admin/account-vault/${target.item.id}`, { method: 'DELETE' })
      delete accountPasswords[target.item.id]
      delete accountTotpCodes[target.item.id]
      window.clearTimeout(totpTimers.get(target.item.id))
      await Promise.all([refreshVault(), refreshReceivers()])
    } else if (target.kind === 'sub') {
      await $fetch(`/api/admin/upstreams/sub/accounts/${target.item.id}`, {
        method: 'DELETE', headers: { 'idempotency-key': clientRandomUUID() }
      })
      await Promise.all([refreshManaged(), refreshQuotas()])
    } else if (target.kind === 'cpa') {
      await $fetch(`/api/admin/upstreams/cpa/auth-files/${target.item.id}`, {
        method: 'DELETE', headers: { 'idempotency-key': clientRandomUUID() }
      })
      await refreshCpa()
    } else if (target.kind === 'receiver') {
      await $fetch(`/api/admin/sms-receivers/${target.item.id}`, { method: 'DELETE' })
      await refreshReceivers()
    } else {
      bindingMutating[target.account.bindingId] = true
      await $fetch(`/api/admin/sms-receivers/${target.receiver.id}/bindings/${target.account.bindingId}`, { method: 'DELETE' })
      await Promise.all([refreshReceivers(), refreshVault()])
      editingReceiver.value = receiverData.value?.items.find(item => item.id === target.receiver.id) || null
      bindingMutating[target.account.bindingId] = false
    }
    deleting.value = null
    showToast('删除操作已完成', 'success')
  } catch (value) {
    showToast(failure(value, '删除操作失败'), 'error')
  } finally {
    if (target.kind === 'binding') bindingMutating[target.account.bindingId] = false
    deletingBusy.value = false
  }
}

onMounted(() => { void loadAccountPasswords() })

onBeforeUnmount(() => { totpTimers.forEach(timer => window.clearTimeout(timer)) })
</script>

<template>
  <div class="admin-page account-vault-page">
    <header class="admin-page__header">
      <div>
        <span class="admin-kicker">ACCOUNT OPERATIONS</span>
        <h1 class="text-balance">账号管理</h1>
        <p class="text-pretty">统一管理号商资料、Sub2API / CPA 号池认证和短信接码。</p>
      </div>
      <div class="admin-header-actions">
        <AppButton variant="secondary" @click="openExport"><IconDownload :size="17" />安全导出</AppButton>
        <AppButton variant="primary" @click="openCreate"><IconPlus :size="17" />新增账号</AppButton>
      </div>
    </header>

    <div class="admin-page-tabs" role="tablist" aria-label="账号管理视图">
      <button type="button" role="tab" :aria-selected="activeTab === 'accounts'" :class="{ active: activeTab === 'accounts' }" @click="activeTab = 'accounts'; search = ''"><IconAddressBook :size="17" />账号管理</button>
      <button type="button" role="tab" :aria-selected="activeTab === 'receivers'" :class="{ active: activeTab === 'receivers' }" @click="activeTab = 'receivers'; search = ''"><IconDeviceMobile :size="17" />接码管理</button>
    </div>

    <section class="admin-toolbar glass-panel account-toolbar">
      <label class="admin-search"><IconSearch :size="17" /><input v-model="search" type="search" :placeholder="activeTab === 'accounts' ? '搜索邮箱、来源、手机号、平台或分组' : '搜索手机号、账号或备注'"></label>
      <span v-if="activeTab === 'accounts'">{{ filteredRows.length }} / {{ unifiedRows.length }} 个账号</span>
      <span v-else>{{ receiverSummary.total }} 个号码 · {{ receiverSummary.available }} 个空余名额</span>
      <button class="icon-button" type="button" title="刷新全部数据" aria-label="刷新全部数据" :disabled="loadingAll" @click="refreshAllData()"><IconRefresh :size="17" :class="{ 'is-spinning': loadingAll }" /></button>
      <AppButton v-if="activeTab === 'accounts' && selectedAccountRows.length" variant="danger" size="small" @click="deleting = { kind: 'bulk-accounts', items: selectedAccountRows }"><IconTrash :size="15" />删除已选（{{ selectedAccountRows.length }}）</AppButton>
      <AppButton v-if="activeTab === 'receivers' && selectedReceivers.length" variant="danger" size="small" @click="deleting = { kind: 'bulk-receivers', items: selectedReceivers }"><IconTrash :size="15" />删除已选（{{ selectedReceivers.length }}）</AppButton>
      <AppButton v-if="activeTab === 'receivers'" variant="primary" size="small" @click="openReceiverCreate"><IconPlus :size="16" />新增接码</AppButton>
    </section>

    <section v-if="activeTab === 'accounts'" class="admin-table-wrap glass-panel account-workspace-table-wrap">
      <table class="admin-table account-workspace-table">
        <thead><tr><th class="selection-column"><label class="table-select"><input type="checkbox" aria-label="全选当前账号" :checked="visibleSelectionState('accounts').all" :indeterminate="visibleSelectionState('accounts').some" :disabled="!selectableAccountRows.length" @change="setVisibleSelection('accounts', ($event.target as HTMLInputElement).checked)"></label></th><th>账号</th><th>来源</th><th>添加时间</th><th>号池 / 凭据 / 状态</th><th>容量 / 调度</th><th>用量窗口</th><th>短信接码</th><th aria-label="操作" /></tr></thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="row.key">
            <td class="selection-cell" data-label="选择">
              <label class="row-select" :title="`选择 ${accountEmail(row)}`"><input v-model="selectedAccountKeys" type="checkbox" :value="row.key" :disabled="!row.vault && !row.sub && !row.cpaFiles.length" :aria-label="`选择账号 ${accountEmail(row)}`"></label>
            </td>
            <td data-label="账号">
              <div class="table-primary-cell">
                <div class="account-identity">
                <div v-if="belongsToSub(row) || row.cpaFiles.length || accountPlan(row)" class="account-badge-row">
                  <span v-if="belongsToSub(row)" class="record-badge" data-tone="sub">SUB</span>
                  <span v-if="row.cpaFiles.length" class="record-badge" data-tone="cpa">CPA</span>
                  <span v-if="accountPlan(row)" class="record-badge" data-tone="plan">{{ accountPlan(row) }}</span>
                </div>
                <div class="account-email-row">
                  <a v-if="row.vault?.hasEmailCodeUrl" class="account-email-link" :href="`/api/admin/account-vault/${row.vault.id}/email-link`" target="_blank" rel="noopener noreferrer" :title="`打开 ${row.vault.email} 的邮箱接码页面`"><IconExternalLink :size="13" /><span>{{ row.vault.email }}</span></a>
                  <code v-else class="account-email" :title="accountEmail(row)">{{ accountEmail(row) }}</code>
                  <button class="account-copy-button" type="button" title="复制账号" :aria-label="`复制账号 ${accountEmail(row)}`" @click="copyText(accountEmail(row), '账号已复制')"><IconCopy :size="13" /></button>
                </div>
                <button v-if="row.vault && accountPasswords[row.vault.id]" class="password-copy" type="button" :title="`复制密码 ${accountPasswords[row.vault.id]}`" @click="copyText(accountPasswords[row.vault.id]!, '账号密码已复制')"><IconCopy :size="13" /><span>{{ accountPasswords[row.vault.id] }}</span></button>
                </div>
              </div>
            </td>
            <td data-label="来源"><span class="record-badge account-source-badge">{{ sourceLabel(row.vault?.source) }}</span></td>
            <td data-label="添加时间"><time v-if="row.vault" class="account-added-at" :datetime="new Date(row.vault.createdAt).toISOString()">{{ time(row.vault.createdAt) }}</time><span v-else class="table-sub">—</span></td>
            <td data-label="号池 / 凭据 / 状态">
              <div class="pool-status">
                <template v-if="row.sub">
                  <span class="sub-status-line"><span class="status-dot" :data-status="subStatusTone(row)"><i />{{ subStatusLabel(row) }}</span><span v-if="subAuthStatusCode(row)" class="sub-status-code">（{{ subAuthStatusCode(row) }}）</span></span>
                  <div v-if="row.vault" class="local-account-status">
                    <span class="record-badge" :data-tone="localSmsTone(row.vault)">{{ localSmsStatus(row.vault) }}</span>
                    <span class="record-badge" data-tone="active">{{ localPoolStatus(row) }}</span>
                  </div>
                </template>
                <template v-else-if="row.cpaFiles.length">
                  <span class="status-dot" :data-status="row.cpaFiles.every(item => item.disabled) ? 'disabled' : statusTone(row.cpaFiles[0]?.status || 'unknown')"><i />{{ row.cpaFiles.every(item => item.disabled) ? '已停用' : localizedStatus(row.cpaFiles[0]?.status || 'unknown') }}</span>
                  <div v-if="row.vault" class="local-account-status">
                    <span class="record-badge" :data-tone="localSmsTone(row.vault)">{{ localSmsStatus(row.vault) }}</span>
                    <span class="record-badge" :data-tone="localPoolTone(row)">{{ localPoolStatus(row) }}</span>
                  </div>
                </template>
                <template v-else-if="row.subPoolStatus === 'deleted'">
                  <div v-if="row.vault" class="local-account-status">
                    <span class="record-badge" :data-tone="localSmsTone(row.vault)">{{ localSmsStatus(row.vault) }}</span>
                    <span class="record-badge" data-tone="error">SUB 已删除</span>
                  </div>
                  <span v-else class="status-dot" data-status="error"><i />SUB 已删除</span>
                </template>
                <template v-else-if="row.vault">
                  <div class="local-account-status">
                    <span class="record-badge" :data-tone="localSmsTone(row.vault)">{{ localSmsStatus(row.vault) }}</span>
                    <span class="record-badge" :data-tone="localPoolTone(row)">{{ localPoolStatus(row) }}</span>
                  </div>
                </template>
                <span v-if="accountTypeLabel(row)" class="record-badge account-kind-badge">{{ accountTypeLabel(row) }}</span>
                <small v-if="row.sub?.groupNames.length" class="table-sub">{{ row.sub.groupNames.join('、') }}</small>
              </div>
            </td>
            <td data-label="容量 / 调度">
              <template v-if="row.sub">
                <strong class="table-value tabular-nums">{{ row.sub.currentConcurrency }} / {{ row.sub.concurrency }}</strong>
                <label class="compact-switch" :class="{ disabled: subMutating[row.sub.id] }">
                  <input type="checkbox" :checked="row.sub.schedulable" :disabled="subMutating[row.sub.id]" @change="toggleSubScheduling(row.sub!, ($event.target as HTMLInputElement).checked)">
                  <span aria-hidden="true" /><em>{{ row.sub.schedulable ? '已启用调度' : '已暂停调度' }}</em>
                </label>
              </template>
              <span v-else-if="row.cpaFiles.length" class="table-muted">{{ row.cpaFiles.length }} 个认证文件<br>CPA 全局调度</span>
              <span v-else-if="row.subPoolStatus === 'deleted'" class="table-muted">Sub 已删除，不参与调度</span>
              <span v-else class="table-muted">未进入 SUB 号池</span>
            </td>
            <td data-label="用量窗口">
              <div v-if="row.quota?.windows.length" class="quota-windows">
                <div v-for="windowItem in row.quota.windows" :key="windowItem.id">
                  <div class="quota-window-summary">
                    <span class="quota-window-heading"><b>{{ windowItem.label }}</b><em>{{ windowItem.remainingPercent !== null ? `${formatQuotaValue(windowItem.remainingPercent)}% 剩余` : `${formatQuotaValue(windowItem.used)} / ${formatQuotaValue(windowItem.limit)}` }}</em></span>
                    <div v-if="windowItem.stats" class="quota-window-stats">
                      <span>{{ formatCompactUsage(windowItem.stats.requests) }}</span>
                      <span>{{ formatCompactUsage(windowItem.stats.tokens) }}</span>
                      <span :title="`上游账号实际成本 ${formatUsd(windowItem.stats.cost)}`">{{ formatUsd(windowItem.stats.cost) }}</span>
                    </div>
                  </div>
                  <div class="quota-window-progress"><i><b :style="{ width: `${Math.max(0, Math.min(100, windowItem.remainingPercent ?? (windowItem.usedPercent === null ? 0 : 100 - windowItem.usedPercent)))}%` }" /></i><small v-if="windowItem.resetAt">{{ time(windowItem.resetAt) }}</small></div>
                </div>
              </div>
              <span v-else-if="row.quota" class="table-muted">{{ row.quota.error || '暂无用量窗口' }}</span>
              <span v-else class="table-muted">—</span>
            </td>
            <td data-label="短信接码">
              <div v-if="row.vault?.smsReceiver" class="account-sms">
                <button class="phone-copy" type="button" :title="`复制 ${row.vault.smsReceiver.copyValue}`" @click="copyText(row.vault.smsReceiver.copyValue, '手机号已复制（不含 +1）')"><IconCopy :size="13" />{{ row.vault.smsReceiver.phone }}</button>
                <div class="account-sms-meta">
                  <IconUsers :size="12" />
                  <span>绑定</span>
                  <strong class="tabular-nums">{{ row.vault.smsReceiver.bindingCount }}/3</strong>
                  <i aria-hidden="true" />
                  <span>当前槽位</span>
                  <strong class="tabular-nums">#{{ row.vault.smsReceiver.slot }}</strong>
                </div>
                <div class="account-sms-code-row">
                  <code v-if="accountSmsCodes[row.vault.id]?.code">{{ accountSmsCodes[row.vault.id]?.code }}</code>
                  <small v-else-if="accountSmsCodes[row.vault.id]" :title="accountSmsCodes[row.vault.id]?.message">{{ smsMessageSummary(accountSmsCodes[row.vault.id]!) }}</small>
                  <small v-else>未获取验证码</small>
                  <button v-if="accountSmsCodes[row.vault.id]?.code" class="icon-button account-sms-icon" type="button" title="复制验证码" aria-label="复制验证码" @click="copyText(accountSmsCodes[row.vault.id]!.code!, '验证码已复制')"><IconCopy :size="13" /></button>
                  <button class="icon-button account-sms-icon" type="button" title="获取短信验证码" aria-label="获取短信验证码" :disabled="refreshingAccountCodes[row.vault.id]" @click="refreshAccountSmsCode(row.vault)"><IconRefresh :size="13" :class="{ 'is-spinning': refreshingAccountCodes[row.vault.id] }" /></button>
                </div>
              </div>
              <span v-else class="table-muted">未分配手机号</span>
            </td>
            <td data-label="操作">
              <div class="table-actions account-row-actions">
                <button v-if="row.vault && !row.sub" class="account-action-button" type="button" title="Auth 登录并接入 Codex" @click="openOAuth(row.vault)"><IconLogin2 :size="14" />授权</button>
                <template v-for="item in row.cpaFiles" :key="item.id">
                  <button class="icon-button" type="button" :title="`验证 CPA：${item.account || item.name}`" :aria-label="`验证 CPA ${item.account || item.name}`" :disabled="cpaMutating[item.id]" @click="verifyCpa(item)"><IconShieldCheck :size="15" /></button>
                  <button class="icon-button" type="button" :title="`${item.disabled ? '启用' : '停用'} CPA：${item.account || item.name}`" :aria-label="`${item.disabled ? '启用' : '停用'} CPA ${item.account || item.name}`" :disabled="cpaMutating[item.id]" @click="toggleCpa(item)"><component :is="item.disabled ? IconPlayerPlay : IconPlayerPause" :size="15" /></button>
                  <button class="icon-button danger" type="button" :title="`删除 CPA：${item.account || item.name}`" :aria-label="`删除 CPA ${item.account || item.name}`" :disabled="cpaMutating[item.id]" @click="deleting = { kind: 'cpa', item }"><IconTrash :size="15" /></button>
                </template>
                <button v-if="row.sub" class="account-action-button" type="button" title="主动验活" :disabled="subMutating[row.sub.id]" @click="verifySub(row.sub)"><IconCircleCheck :size="14" />验活</button>
                <button v-if="row.sub" class="account-action-button" type="button" title="检测账号状态并刷新用量窗口" :disabled="quotaRefreshing[row.sub.id]" @click="refreshQuota(row.sub)"><IconRefresh :size="14" :class="{ 'is-spinning': quotaRefreshing[row.sub.id] }" />刷新</button>
                <button v-if="row.sub" class="account-action-button" type="button" title="编辑 Sub2API 配置" @click="openSubEdit(row.sub)"><IconEdit :size="14" />编辑</button>
                <button v-if="row.vault" class="account-action-button" type="button" title="编辑账号资料" @click="openEdit(row.vault)"><IconAddressBook :size="14" />资料</button>
                <button v-if="row.vault" class="account-action-button account-action-button--danger" type="button" title="删除本地账号" @click="deleting = { kind: 'vault', item: row.vault }"><IconTrash :size="14" />删除</button>
                <button v-else-if="row.sub" class="account-action-button account-action-button--danger" type="button" title="删除 Sub2API 账号" @click="deleting = { kind: 'sub', item: row.sub }"><IconTrash :size="14" />删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredRows.length"><td colspan="9"><div class="admin-empty account-empty"><IconAddressBook :size="24" /><span>{{ unifiedRows.length ? '没有匹配的账号' : '还没有账号' }}</span><AppButton v-if="!unifiedRows.length" variant="primary" size="small" @click="openCreate">新增第一个账号</AppButton></div></td></tr>
        </tbody>
      </table>
    </section>

    <template v-else>
      <section class="admin-table-wrap glass-panel receiver-table-wrap receiver-table-wrap--page">
        <table class="admin-table receiver-table">
          <thead><tr><th class="selection-column"><label class="table-select"><input type="checkbox" aria-label="全选当前可删除接码" :checked="visibleSelectionState('receivers').all" :indeterminate="visibleSelectionState('receivers').some" :disabled="!selectableReceivers.length" @change="setVisibleSelection('receivers', ($event.target as HTMLInputElement).checked)"></label></th><th>接码手机号</th><th>绑定数量</th><th>状态</th><th>最新验证码</th><th>最近刷新</th><th aria-label="操作" /></tr></thead>
          <tbody>
            <tr v-for="receiver in filteredReceivers" :key="receiver.id">
              <td class="selection-cell" data-label="选择"><label class="row-select" :title="receiver.bindingCount === 0 || receiver.readyForDeletion ? `选择 ${receiver.phone}` : '仍有有效占用，不能删除'"><input v-model="selectedReceiverIds" type="checkbox" :value="receiver.id" :disabled="receiver.bindingCount > 0 && !receiver.readyForDeletion" :aria-label="`选择接码 ${receiver.phone}`"></label></td>
              <td data-label="接码手机号"><div class="table-primary-cell"><div><div class="receiver-phone-line"><button class="phone-copy" type="button" :title="`复制 ${receiver.copyValue}`" @click="copyText(receiver.copyValue, '手机号已复制（不含 +1）')"><IconCopy :size="13" />{{ receiver.phone }}</button><span v-if="receiver.readyForDeletion" class="record-badge" data-tone="error" title="3 个绑定账号均已删除，可清理此接码">可删除</span></div><small class="table-sub">{{ receiver.providerHost }}<template v-if="receiver.note"> · {{ receiver.note }}</template></small></div></div></td>
              <td data-label="绑定数量"><div class="receiver-count"><IconUsers :size="15" /><strong class="tabular-nums">{{ receiver.bindingCount }}/3</strong><small>{{ receiver.availableSlots }} 个空余名额</small></div></td>
              <td data-label="状态"><label class="compact-switch" :class="{ disabled: receiverMutating[receiver.id] }"><input type="checkbox" :checked="receiver.status === 'active'" :disabled="receiverMutating[receiver.id]" @change="toggleReceiver(receiver, ($event.target as HTMLInputElement).checked)"><span aria-hidden="true" /><em>{{ receiver.status === 'active' ? '可用' : '停用' }}</em></label></td>
              <td data-label="最新验证码"><div class="receiver-code receiver-code--table"><code v-if="smsCodes[receiver.id]?.code">{{ smsCodes[receiver.id]?.code }}</code><span v-else-if="smsCodes[receiver.id]" :title="smsCodes[receiver.id]?.message">{{ smsMessageSummary(smsCodes[receiver.id]!) }}</span><span v-else>未获取</span><button v-if="smsCodes[receiver.id]?.code" class="icon-button" type="button" title="复制验证码" aria-label="复制验证码" @click="copyText(smsCodes[receiver.id]!.code!, '验证码已复制')"><IconCopy :size="14" /></button></div></td>
              <td data-label="最近刷新"><strong>{{ time(receiver.lastFetchedAt) }}</strong><small v-if="receiver.lastFetchStatus === 'error'" class="table-sub receiver-fetch-error">{{ receiver.lastFetchError || '刷新失败' }}</small><small v-else class="table-sub">{{ receiver.lastFetchStatus === 'code_received' ? '已获取验证码' : receiver.lastFetchStatus === 'no_code' ? '暂无新验证码' : '—' }}</small></td>
              <td data-label="操作"><div class="table-actions"><button class="icon-button" type="button" title="刷新验证码" aria-label="刷新验证码" :disabled="receiver.status !== 'active' || refreshingCodes[receiver.id]" @click="refreshSmsCode(receiver.id)"><IconRefresh :size="16" :class="{ 'is-spinning': refreshingCodes[receiver.id] }" /></button><button class="icon-button" type="button" title="编辑接码" aria-label="编辑接码" @click="openReceiverEdit(receiver)"><IconEdit :size="16" /></button><button class="icon-button danger" type="button" title="删除接码" aria-label="删除接码" :disabled="(receiver.bindingCount > 0 && !receiver.readyForDeletion) || receiverMutating[receiver.id]" @click="deleting = { kind: 'receiver', item: receiver }"><IconTrash :size="16" /></button></div></td>
            </tr>
            <tr v-if="!filteredReceivers.length"><td colspan="7"><div class="admin-empty account-empty"><IconDeviceMobile :size="24" /><span>{{ receiverData?.items.length ? '没有匹配的接码资源' : '暂无接码资源' }}</span><AppButton v-if="!receiverData?.items.length" variant="primary" size="small" @click="openReceiverCreate">新增第一个接码</AppButton></div></td></tr>
          </tbody>
        </table>
      </section>
    </template>

    <Transition name="hub-layer">
      <div v-if="showReceiverForm" class="admin-modal-backdrop account-vault-layer" @click.self="closeReceiverForm">
      <section class="admin-modal admin-modal--wide receiver-editor-modal hub-layer-panel" role="dialog" aria-modal="true" :aria-label="editingReceiver ? '编辑接码' : '新增接码'">
        <header><div><span>SMS RECEIVER</span><h2 class="text-balance">{{ editingReceiver ? '编辑接码' : '新增接码' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="receiverSaving" @click="closeReceiverForm"><IconX :size="18" /></button></header>
        <div v-if="!editingReceiver" class="admin-page-tabs vault-create-modes receiver-create-modes" role="tablist" aria-label="接码新增方式">
          <button type="button" role="tab" :aria-selected="receiverCreateMode === 'single'" :class="{ active: receiverCreateMode === 'single' }" :disabled="receiverSaving" @click="receiverCreateMode = 'single'; receiverError = ''">单个添加</button>
          <button type="button" role="tab" :aria-selected="receiverCreateMode === 'batch'" :class="{ active: receiverCreateMode === 'batch' }" :disabled="receiverSaving" @click="receiverCreateMode = 'batch'; receiverError = ''">批量导入</button>
        </div>
        <form class="admin-form receiver-editor" @submit.prevent="saveReceiver">
          <template v-if="editingReceiver || receiverCreateMode === 'single'">
            <div class="form-grid"><label><span>接码手机号 *</span><input v-model="receiverForm.phone" required maxlength="40" inputmode="tel" placeholder="支持 10 位或前导 1"></label><label><span>{{ editingReceiver ? '接码接口 URL（留空不修改）' : '接码接口 URL *' }}</span><input v-model="receiverForm.fetchUrl" type="url" :required="!editingReceiver" maxlength="3000" placeholder="https://"></label></div>
            <div class="receiver-editor__bottom"><label><span>备注</span><input v-model="receiverForm.note" maxlength="500"></label><label class="receiver-toggle"><input v-model="receiverForm.active" type="checkbox"><span><strong>启用接码</strong><small>停用后不能刷新验证码或绑定新账号</small></span></label></div>
            <section v-if="editingReceiver" class="receiver-bindings" aria-labelledby="receiver-bindings-title">
              <header><div><h3 id="receiver-bindings-title">绑定账号</h3><span class="tabular-nums">{{ editingReceiver.bindingCount }}/3</span></div><small>{{ editingReceiver.availableSlots }} 个空余名额</small></header>
              <div v-if="editingReceiver.accounts.length" class="receiver-bindings__list">
                <div v-for="account in editingReceiver.accounts" :key="account.bindingId" :data-deleted="account.deleted">
                  <span><strong>{{ account.displayName || account.email }}</strong><small>#{{ account.slot }} · {{ account.email }}{{ account.manual ? ' · 手动占用' : account.deleted ? ' · 已删除账号' : '' }}</small></span>
                  <button class="icon-button danger" type="button" title="解除账号绑定" aria-label="解除账号绑定" :disabled="bindingMutating[account.bindingId]" @click="deleting = { kind: 'binding', receiver: editingReceiver!, account }"><IconTrash :size="15" /></button>
                </div>
              </div>
              <div v-else class="receiver-bindings__empty"><IconUsers :size="19" /><span>尚未绑定账号</span></div>
              <div v-if="editingReceiver.availableSlots > 0" class="receiver-manual-binding">
                <div><label><span>手动占用账号 *</span><input v-model="manualBindingForm.email" required maxlength="320" placeholder="dev@example.com 或 product" autocomplete="off"></label><label><span>显示名称</span><input v-model="manualBindingForm.displayName" maxlength="200" placeholder="可选" autocomplete="off"></label></div>
                <button class="button button--secondary button--small" type="button" :disabled="manualBindingSaving || !manualBindingForm.email.trim()" @click="addManualBinding"><IconPlus :size="14" />{{ manualBindingSaving ? '添加中' : '添加占用' }}</button>
                <p v-if="manualBindingError" class="form-error">{{ manualBindingError }}</p>
              </div>
            </section>
          </template>
          <template v-else>
            <label><span>接码发货文本 *</span><textarea v-model="receiverImportText" class="receiver-import-input" required rows="9" maxlength="2097152" autocomplete="off" spellcheck="false" placeholder="16232130689|https://eim388.top/api/sms/access?token=...&#10;14103012139|https://eim388.top/api/sms/access?token=..." /></label>
            <div v-if="receiverImportPreview.length" class="sub-import-preview receiver-import-preview" aria-label="接码导入预览">
              <div v-for="item in receiverImportPreview.slice(0, 20)" :key="item.line" :data-valid="item.valid">
                <span><strong>第 {{ item.line }} 行 · {{ item.phone }}</strong><small>{{ item.valid ? item.providerHost : '格式错误' }}</small></span>
                <code>{{ item.valid ? '待导入' : '请检查' }}</code>
              </div>
              <small v-if="receiverImportPreview.length > 20">另有 {{ receiverImportPreview.length - 20 }} 行</small>
            </div>
          </template>
          <p v-if="receiverError" class="form-error">{{ receiverError }}</p>
          <footer><span v-if="!editingReceiver && receiverCreateMode === 'batch'">已识别 {{ receiverImportPreview.length }} 行</span><button class="button button--secondary" type="button" @click="closeReceiverForm">取消</button><button class="button button--primary" :disabled="receiverSaving || (!editingReceiver && receiverCreateMode === 'batch' && !receiverImportPreview.length)">{{ receiverSaving ? (receiverCreateMode === 'batch' ? '导入中' : '保存中') : (!editingReceiver && receiverCreateMode === 'batch' ? `导入 ${receiverImportPreview.length} 个接码` : '保存接码') }}</button></footer>
        </form>
      </section>
      </div>
    </Transition>

    <Transition name="hub-layer">
      <div v-if="showForm" class="admin-modal-backdrop account-vault-layer" @click.self="closeForm">
      <section class="admin-modal admin-modal--wide account-editor-modal hub-layer-panel" role="dialog" aria-modal="true" :aria-label="editing ? '编辑账号' : '新增账号'">
        <header class="account-editor-header"><div class="account-editor-heading"><span class="account-editor-title-icon"><component :is="editing ? IconEdit : IconAddressBook" :size="18" :stroke-width="1.7" /></span><div><span>ACCOUNT RECORD</span><h2 class="text-balance">{{ editing ? '编辑账号' : '新增账号' }}</h2><p>{{ editing ? '更新账号资料与验证方式' : '录入账号或导入现有凭据' }}</p></div></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="saving || deliveryImporting || importSaving || cpaUploadSaving || conversionSaving" @click="closeForm"><IconX :size="18" :stroke-width="1.8" /></button></header>
        <form v-if="editing || accountCreateMode === 'manual'" class="admin-form account-editor-form" @submit.prevent="saveVault">
          <div class="account-editor-layout">
            <section class="account-editor-main">
              <header class="account-editor-section-heading"><div><span>ACCOUNT</span><h3>账号资料</h3></div><small>身份与登录凭据</small></header>
              <div v-if="!editing" class="admin-page-tabs admin-page-tabs--embedded account-editor-tabs" role="tablist" aria-label="新增账号方式">
                <button class="active" type="button" role="tab" aria-selected="true" @click="accountCreateMode = 'manual'; formError = ''">手动</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'upload'; importError = ''; cpaUploadError = ''">上传</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'batch'; deliveryError = ''">批量导入</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'convert'; conversionError = ''">凭据转换</button>
              </div>
              <div class="form-grid"><label><span>邮箱 *</span><input v-model="form.email" type="email" required autocomplete="off"></label><label><span>姓名</span><input v-model="form.displayName" maxlength="120"></label></div>
              <div class="form-grid"><label><span>来源 *</span><AppSelect v-model="form.source" required><option value="" disabled>请选择来源</option><option v-for="source in ACCOUNT_VAULT_SOURCES.filter(item => item !== 'unknown')" :key="source" :value="source">{{ sourceLabel(source) }}</option><option v-if="editing?.source === 'unknown'" value="unknown">未标注</option></AppSelect></label><label><span>账号状态</span><AppSelect v-model="form.status"><option v-for="status in ACCOUNT_VAULT_STATUSES" :key="status" :value="status">{{ status }}</option></AppSelect></label></div>
              <label><span>{{ editing ? '新密码（留空不修改）' : '账号密码' }}</span><input v-model="form.password" type="password" maxlength="2000" autocomplete="new-password"></label>
              <label><span>备注</span><textarea v-model="form.remark" maxlength="2000" rows="5" /></label>
            </section>
            <aside class="account-editor-aside">
              <header class="account-editor-aside-heading"><span class="account-editor-aside-icon"><IconShieldCheck :size="16" :stroke-width="1.7" /></span><div><span>SECURITY</span><h3>验证与接码</h3><p>账号安全资料</p></div><code>{{ form.status.toUpperCase() }}</code></header>
              <label><span>邮箱验证码链接{{ editing && editing.hasEmailCodeUrl ? '（已保存；填写新链接可替换）' : '' }}</span><input v-model="form.emailCodeUrl" type="url" maxlength="4000" placeholder="https://" @input="emailCodeUrlTouched = true"></label>
              <label><span>2FA 密钥{{ editing && editing.hasTotpSecret ? '（已保存；填写新密钥可替换）' : '' }}</span><input v-model="form.totpSecret" type="password" maxlength="512" autocomplete="off" placeholder="Base32" @input="totpSecretTouched = true"></label>
              <label><span>接码手机号</span><AppSelect v-model="form.smsReceiverId"><option value="">自动分配可用手机号</option><option v-for="receiver in receiverOptions" :key="receiver.id" :value="receiver.id">{{ receiver.phone }} · {{ receiver.bindingCount }}/3</option></AppSelect><small>没有可用号码时仍会创建账号。</small></label>
            </aside>
          </div>
          <p v-if="formError" class="form-error account-editor-message">{{ formError }}</p>
          <footer class="account-editor-footer"><AppButton @click="closeForm">取消</AppButton><AppButton variant="primary" type="submit" :loading="saving" loading-label="保存中"><IconShieldCheck :size="15" :stroke-width="1.8" />{{ editing ? '保存修改' : '保存账号' }}</AppButton></footer>
        </form>

        <form v-else-if="accountCreateMode === 'upload'" class="admin-form account-editor-form vault-upload-form" @submit.prevent="uploadSelectedPool">
          <div class="account-editor-layout">
            <section class="account-editor-main">
              <header class="account-editor-section-heading"><div><span>UPLOAD</span><h3>上传内容</h3></div><small>JSON 账号文件</small></header>
              <div class="admin-page-tabs admin-page-tabs--embedded account-editor-tabs" role="tablist" aria-label="新增账号方式">
                <button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'manual'; formError = ''">手动</button><button class="active" type="button" role="tab" aria-selected="true" @click="accountCreateMode = 'upload'; importError = ''; cpaUploadError = ''">上传</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'batch'; deliveryError = ''">批量导入</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'convert'; conversionError = ''">凭据转换</button>
              </div>
              <label><span>号池平台 *</span><AppSelect v-model="uploadPool" :disabled="importSaving || cpaUploadSaving"><option value="sub2api">Sub2API</option><option value="cpa">CPA</option></AppSelect><small>{{ uploadPool === 'sub2api' ? '导入 Sub2API 导出的账号 JSON。' : '上传 CPA 认证 JSON，每批最多 20 个文件。' }}</small></label>
              <template v-if="uploadPool === 'sub2api'">
                <label class="credential-drop credential-drop--compact"><input type="file" accept="application/json,.json" @change="readImportFile"><span class="credential-drop-copy"><IconFileCode :size="22" /><strong>选择 Sub2API 账号 JSON</strong><small>{{ importFileName || '单个 JSON 文件，也可以在下方直接粘贴' }}</small></span></label>
                <label><span>JSON 内容 *</span><textarea v-model="importText" rows="10" required spellcheck="false" autocomplete="off" placeholder="{ }" @input="importRows = []" /></label>
                <AppButton size="small" class="import-parse-button" @click="parseImportText(importText)"><IconFileCode :size="16" />解析内容</AppButton>
              </template>
              <label v-else class="credential-drop"><input type="file" multiple accept="application/json,.json" required @change="selectCpaFiles"><span class="credential-drop-copy"><IconFileCode :size="24" /><strong>选择 CPA 认证文件</strong><small>{{ cpaUploadFiles.length ? `已选择 ${cpaUploadFiles.length} 个文件` : '每个最大 2 MiB，单次最多 20 个 JSON 文件' }}</small></span></label>
            </section>
            <aside class="account-editor-aside">
              <header class="account-editor-aside-heading"><span class="account-editor-aside-icon"><IconCloudUpload :size="16" :stroke-width="1.7" /></span><div><span>IMPORT</span><h3>导入设置</h3><p>{{ uploadPool }}</p></div><code>{{ uploadPool === 'sub2api' ? importRows.length : cpaUploadFiles.length }}</code></header>
              <template v-if="uploadPool === 'sub2api'">
                <div class="account-editor-switches"><label class="switch"><input v-model="importSchedulable" type="checkbox"><span />导入后立即调度</label><label class="switch"><input v-model="importAdvancedRaw" type="checkbox"><span />允许高级原始凭据</label></div>
                <div v-if="importRows.length" class="sub-import-preview"><div v-for="row in importRows.slice(0, 20)" :key="row.key"><span><strong>{{ row.name }}</strong><small>{{ row.email || '未识别邮箱' }}</small></span><code>{{ row.platform }} / {{ row.type }}</code></div><small v-if="importRows.length > 20">另有 {{ importRows.length - 20 }} 个账号</small></div>
                <div v-else class="account-editor-empty"><IconFileCode :size="20" /><span>暂无解析结果</span></div>
              </template>
              <div v-else class="account-editor-file-state"><strong class="tabular-nums">{{ cpaUploadFiles.length }}</strong><span>个待上传文件</span></div>
            </aside>
          </div>
          <p v-if="importError || cpaUploadError" class="form-error vault-delivery-error account-editor-message">{{ importError || cpaUploadError }}</p>
          <footer class="account-editor-footer"><span>{{ uploadPool === 'sub2api' ? `${importRows.length} 个账号` : `${cpaUploadFiles.length} 个文件` }}</span><AppButton :disabled="importSaving || cpaUploadSaving" @click="closeForm">取消</AppButton><AppButton variant="primary" type="submit" :loading="uploadPool === 'sub2api' ? importSaving : cpaUploadSaving" :loading-label="uploadPool === 'sub2api' ? '导入中' : '上传中'" :disabled="uploadPool === 'sub2api' ? !importRows.length : !cpaUploadFiles.length"><IconCloudUpload :size="16" />{{ uploadPool === 'sub2api' ? '导入 Sub2API' : '上传到 CPA' }}</AppButton></footer>
        </form>

        <form v-else-if="accountCreateMode === 'batch'" class="admin-form account-editor-form vault-delivery-form" @submit.prevent="importDelivery">
          <div class="account-editor-layout">
            <section class="account-editor-main">
              <header class="account-editor-section-heading"><div><span>BATCH</span><h3>批量数据</h3></div><small>结构化发货文本</small></header>
              <div class="admin-page-tabs admin-page-tabs--embedded account-editor-tabs" role="tablist" aria-label="新增账号方式">
                <button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'manual'; formError = ''">手动</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'upload'; importError = ''; cpaUploadError = ''">上传</button><button class="active" type="button" role="tab" aria-selected="true" @click="accountCreateMode = 'batch'; deliveryError = ''">批量导入</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'convert'; conversionError = ''">凭据转换</button>
              </div>
              <div class="delivery-config-grid">
                <label><span>来源 *</span><AppSelect v-model="deliverySource" :disabled="deliveryImporting"><option value="" disabled>请选择来源</option><option v-for="source in ACCOUNT_VAULT_SOURCES.filter(item => item !== 'unknown')" :key="source" :value="source">{{ sourceLabel(source) }}</option></AppSelect></label>
                <fieldset class="delivery-field-picker"><legend>本批包含的字段</legend><div><label v-for="field in deliveryFieldOptions" :key="field.value"><input type="checkbox" :checked="deliveryFields.includes(field.value)" :disabled="field.value === 'email' || deliveryImporting" @change="toggleDeliveryField(field.value)"><span>{{ field.label }}</span></label></div></fieldset>
              </div>
              <fieldset class="delivery-field-order"><legend>字段顺序</legend><ol><li v-for="(field, index) in deliveryFields" :key="field"><code>{{ index + 1 }}</code><span>{{ deliveryFieldLabels[field] }}</span><button type="button" title="上移字段" :disabled="index === 0 || deliveryImporting" @click="moveDeliveryField(field, -1)"><IconArrowUp :size="14" /></button><button type="button" title="下移字段" :disabled="index === deliveryFields.length - 1 || deliveryImporting" @click="moveDeliveryField(field, 1)"><IconArrowDown :size="14" /></button></li></ol><small>每行按照以上顺序使用 <code>----</code> 分隔。</small></fieldset>
              <p v-if="deliveryConfigurationError" class="form-error delivery-configuration-error">{{ deliveryConfigurationError }}</p>
              <label><span>发货内容 *</span><textarea v-model="deliveryText" class="vault-delivery-input" required rows="12" autocomplete="off" spellcheck="false" :placeholder="selectedDeliveryFormat.placeholder" /></label>
            </section>
            <aside class="account-editor-aside">
              <header class="account-editor-aside-heading"><span class="account-editor-aside-icon"><IconAddressBook :size="16" :stroke-width="1.7" /></span><div><span>PREVIEW</span><h3>导入预览</h3><p>{{ selectedDeliveryFormat.label }}</p></div><code>{{ deliveryPreview.length }}</code></header>
              <div v-if="deliveryPreview.length" class="vault-delivery-preview"><div v-for="item in deliveryPreview.slice(0, 50)" :key="item.index" :data-valid="item.valid"><code>{{ item.email }}</code><span>{{ item.kind }}</span></div><small v-if="deliveryPreview.length > 50">另有 {{ deliveryPreview.length - 50 }} 条待导入</small></div>
              <div v-else class="account-editor-empty"><IconAddressBook :size="20" /><span>暂无可预览账号</span></div>
            </aside>
          </div>
          <p v-if="deliveryError" class="form-error vault-delivery-error account-editor-message">{{ deliveryError }}</p>
          <footer class="account-editor-footer"><span>{{ deliveryPreview.length }} 个账号</span><AppButton :disabled="deliveryImporting" @click="closeForm">取消</AppButton><AppButton variant="primary" type="submit" :loading="deliveryImporting" loading-label="导入中" :disabled="!deliverySource || Boolean(deliveryConfigurationError) || !deliveryPreview.length"><IconCloudUpload :size="16" />确认导入</AppButton></footer>
        </form>

        <form v-else class="admin-form account-editor-form credential-converter-form" @submit.prevent="importConvertedCredentials">
          <div class="account-editor-layout">
            <section class="account-editor-main">
              <header class="account-editor-section-heading"><div><span>CREDENTIALS</span><h3>{{ conversionRows.length ? '账号凭据' : '凭据来源' }}</h3></div><small>{{ conversionRows.length ? `${conversionRows.length} 个账号` : 'Session 或认证 JSON' }}</small></header>
              <div class="admin-page-tabs admin-page-tabs--embedded account-editor-tabs" role="tablist" aria-label="新增账号方式">
                <button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'manual'; formError = ''">手动</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'upload'; importError = ''; cpaUploadError = ''">上传</button><button type="button" role="tab" aria-selected="false" @click="accountCreateMode = 'batch'; deliveryError = ''">批量导入</button><button class="active" type="button" role="tab" aria-selected="true" @click="accountCreateMode = 'convert'; conversionError = ''">凭据转换</button>
              </div>
              <div v-show="!conversionRows.length" class="credential-converter-source">
                <label class="credential-drop credential-converter-drop"><input type="file" multiple accept="application/json,.json" @change="readConversionFiles"><span class="credential-drop-copy"><IconFileCode :size="24" /><strong>选择 ChatGPT Session 或认证 JSON</strong><small>最多 20 个文件，单个文件最大 2 MiB</small></span></label>
                <label><span>粘贴凭据 JSON</span><textarea v-model="conversionInput" rows="8" spellcheck="false" autocomplete="off" placeholder="{ }" /></label>
                <AppButton size="small" class="import-parse-button" :disabled="!conversionInput.trim()" @click="parseConversionInput"><IconFileCode :size="16" />解析凭据</AppButton>
              </div>
              <template v-if="conversionRows.length">
                <div class="conversion-summary"><span><strong class="tabular-nums">{{ conversionRows.length }}</strong><small>已识别账号</small></span><span><strong class="tabular-nums">{{ conversionFileCount }}</strong><small>来源文件</small></span><span><strong class="tabular-nums">{{ conversionSkipped.length }}</strong><small>跳过项目</small></span><AppButton variant="quiet" size="small" :disabled="conversionSaving" @click="resetConversionForm">重新选择</AppButton></div>
                <div class="conversion-list" aria-label="转换账号预览">
                  <article v-for="item in conversionRows" :key="item.key" :data-selected="item.selected">
                    <label class="conversion-select"><input v-model="item.selected" type="checkbox" :aria-label="`选择 ${item.email || item.name}`"></label>
                    <div class="conversion-identity"><strong>{{ item.name }}</strong><code>{{ item.email || item.accountId || '未识别账号标识' }}</code><small>{{ conversionSourceLabel(item.sourceType) }} · {{ item.planType || '未知套餐' }} · {{ item.expiresAt ? time(item.expiresAt) : '可持续刷新' }}</small></div>
                    <div class="conversion-flags"><span class="record-badge" :data-tone="item.hasRefreshToken ? 'active' : 'neutral'">{{ item.hasRefreshToken ? '可刷新' : '短期凭据' }}</span><span v-if="item.syntheticIdToken" class="record-badge">合成 ID Token</span><span v-if="item.expiresAt && item.expiresAt <= Date.now()" class="record-badge" data-tone="error">已过期</span></div>
                    <div class="conversion-targets">
                      <label :class="{ disabled: !item.cpaReady || item.cpaState === 'success' }"><input v-model="item.targets" type="checkbox" value="cpa" :disabled="!item.cpaReady || item.cpaState === 'success'" :aria-label="`导入 ${item.email || item.name} 到 CPA`"><span>CPA<small v-if="conversionTargetStatus(item, 'cpa')">{{ conversionTargetStatus(item, 'cpa') }}</small></span></label>
                      <label :class="{ disabled: item.sub2apiState === 'success' }"><input v-model="item.targets" type="checkbox" value="sub2api" :disabled="item.sub2apiState === 'success'" :aria-label="`导入 ${item.email || item.name} 到 Sub2API`"><span>Sub2API<small v-if="conversionTargetStatus(item, 'sub2api')">{{ conversionTargetStatus(item, 'sub2api') }}</small></span></label>
                    </div>
                    <p v-if="item.warnings.length || item.cpaError || item.sub2apiError" class="conversion-warning">{{ [item.warnings.join('、'), item.cpaError, item.sub2apiError].filter(Boolean).join('；') }}</p>
                  </article>
                </div>
              </template>
            </section>
            <aside class="account-editor-aside">
              <header class="account-editor-aside-heading"><span class="account-editor-aside-icon"><IconCloudUpload :size="16" :stroke-width="1.7" /></span><div><span>TARGETS</span><h3>导入配置</h3><p>CPA {{ conversionCpaCount }} · Sub2API {{ conversionSub2ApiCount }}</p></div><code>{{ selectedConversionRows.length }}</code></header>
              <section v-if="conversionSub2ApiCount" class="conversion-settings" aria-labelledby="conversion-sub-settings">
                <header><h3 id="conversion-sub-settings">Sub2API 导入设置</h3><span>{{ conversionSub2ApiCount }} 个待导入账号</span></header>
                <div class="form-grid form-grid--four"><label><span>并发</span><input v-model.number="conversionConfig.concurrency" type="number" min="1" max="10000" required></label><label><span>优先级</span><input v-model.number="conversionConfig.priority" type="number" min="0" max="1000000" required></label><label><span>倍率</span><input v-model.number="conversionConfig.rateMultiplier" type="number" min="0" max="1000" step="0.01" required></label><label><span>账号代理</span><AppSelect v-model="conversionConfig.proxyId"><option :value="null">不使用代理（直连）</option><option v-for="proxy in activeProxies()" :key="proxy.id" :value="proxy.id">{{ proxy.name }} · {{ proxy.protocol }}://{{ proxy.host }}:{{ proxy.port }}</option></AppSelect></label></div>
                <fieldset class="group-picker"><legend>所属分组</legend><label v-for="group in groups" :key="group.id"><input v-model="conversionConfig.groupIds" type="checkbox" :value="group.id"><span>{{ group.name }}<small>{{ group.platform }}</small></span></label></fieldset>
                <label class="switch"><input v-model="conversionConfig.schedulable" type="checkbox"><span />导入后立即调度</label>
              </section>
              <div v-else class="account-editor-empty"><IconShieldCheck :size="20" /><span>{{ conversionRows.length ? '当前无需 Sub2API 配置' : '等待解析凭据' }}</span></div>
            </aside>
          </div>
          <p v-if="conversionSkipped.length && conversionRows.length" class="conversion-skipped account-editor-message">已跳过 {{ conversionSkipped.length }} 项：{{ conversionSkipped.slice(0, 3).map(item => `${item.sourceName} ${item.message}`).join('；') }}</p>
          <p v-if="conversionError" class="form-error vault-delivery-error account-editor-message">{{ conversionError }}</p>
          <footer class="account-editor-footer"><span>{{ selectedConversionRows.length }} 个账号 · CPA {{ conversionCpaCount }} · Sub2API {{ conversionSub2ApiCount }}</span><AppButton :disabled="conversionSaving" @click="closeForm">取消</AppButton><AppButton v-if="conversionRows.length" variant="primary" type="submit" :loading="conversionSaving" loading-label="导入中" :disabled="!selectedConversionRows.length || (!conversionCpaCount && !conversionSub2ApiCount)"><IconCloudUpload :size="16" />转换并导入</AppButton></footer>
        </form>
      </section>
      </div>
    </Transition>

    <Transition name="hub-layer">
      <div v-if="oauthAccount" class="admin-modal-backdrop account-vault-layer" @click.self="oauthAccount = null">
      <section class="admin-modal admin-modal--wide oauth-account-modal hub-layer-panel" role="dialog" aria-modal="true" aria-label="接入 Codex">
        <header><div><span>SUB2API OAUTH</span><h2 class="text-balance">接入 Codex</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="oauthSaving" @click="oauthAccount = null"><IconX :size="18" /></button></header>
        <form class="admin-form oauth-account-form" @submit.prevent="oauthForm.flowId ? completeOAuth() : startOAuth()">
          <div class="oauth-account-summary">
            <span><strong>{{ oauthAccount.email }}</strong><small>账号</small></span>
            <span><strong>{{ oauthAccount.smsReceiver?.phone || '未分配' }}</strong><small>接码手机号</small></span>
            <span><strong>{{ oauthForm.concurrency }}</strong><small>并发</small></span>
            <span><strong>{{ oauthForm.schedulable ? '开启' : '关闭' }}</strong><small>调度</small></span>
          </div>
          <div v-if="oauthAccount.smsReceiver || oauthAccount.hasTotpSecret" class="oauth-login-tools">
            <button v-if="oauthAccount.smsReceiver" class="button button--secondary button--small" type="button" @click="copyText(oauthAccount.smsReceiver.copyValue, '手机号已复制（不含 +1）')"><IconCopy :size="15" />复制手机号</button>
            <button v-if="oauthAccount.smsReceiver" class="button button--secondary button--small" type="button" :disabled="refreshingAccountCodes[oauthAccount.id]" @click="refreshAccountSmsCode(oauthAccount)"><IconRefresh :size="15" :class="{ 'is-spinning': refreshingAccountCodes[oauthAccount.id] }" />获取短信验证码</button>
            <button v-if="accountSmsCodes[oauthAccount.id]?.code" class="button button--primary button--small" type="button" @click="copyText(accountSmsCodes[oauthAccount.id]!.code!, '验证码已复制')"><IconCopy :size="15" />{{ accountSmsCodes[oauthAccount.id]?.code }}</button>
            <button v-if="oauthAccount.hasTotpSecret" class="button button--secondary button--small" type="button" :disabled="generatingTotp[oauthAccount.id]" @click="generateAccountTotp(oauthAccount)"><IconShieldCheck :size="15" />获取 2FA 验证码</button>
            <button v-if="accountTotpCodes[oauthAccount.id]" class="button button--primary button--small" type="button" @click="copyText(accountTotpCodes[oauthAccount.id]!.code, '2FA 验证码已复制')"><IconCopy :size="15" />{{ accountTotpCodes[oauthAccount.id]?.code }}</button>
          </div>
          <template v-if="!oauthForm.flowId">
            <div class="form-grid"><label><span>账号名称</span><input v-model="oauthForm.name" maxlength="160"></label><label><span>账号代理</span><AppSelect v-model="oauthForm.proxyId"><option :value="null">不使用代理（直连）</option><option v-for="item in activeProxies()" :key="item.id" :value="item.id">{{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}</option></AppSelect></label></div>
            <div class="form-grid"><label><span>并发</span><input v-model.number="oauthForm.concurrency" type="number" min="1" max="10000" required></label><label><span>优先级</span><input v-model.number="oauthForm.priority" type="number" min="0" max="1000000" required></label></div>
            <fieldset class="group-picker oauth-group-picker"><legend>所属分组</legend><label v-for="item in groups" :key="item.id"><input v-model="oauthForm.groupIds" type="checkbox" :value="item.id"><span>{{ item.name }}<small>{{ item.platform }}</small></span></label></fieldset>
            <label class="switch"><input v-model="oauthForm.schedulable" type="checkbox"><span />授权后立即调度</label>
          </template>
          <template v-else>
            <section class="oauth-link-section">
              <header><div><h3>授权链接</h3><span>{{ oauthForm.expiresAt ? `有效至 ${time(oauthForm.expiresAt)}` : '30 分钟内有效' }}</span></div><div><button type="button" class="button button--quiet button--small" @click="copyText(oauthForm.authorizationUrl, '授权链接已复制')"><IconCopy :size="15" />复制</button><a class="button button--secondary button--small" :href="oauthForm.authorizationUrl" target="_blank" rel="noopener noreferrer"><IconExternalLink :size="15" />打开</a></div></header>
              <input :value="oauthForm.authorizationUrl" readonly aria-label="OpenAI 授权链接" @focus="($event.target as HTMLInputElement).select()">
            </section>
            <label class="oauth-callback-field"><span>localhost 回调 URL *</span><textarea v-model="oauthForm.callbackUrl" rows="4" required spellcheck="false" autocomplete="off" placeholder="http://localhost:1455/auth/callback?code=...&state=..." /></label>
          </template>
          <p v-if="oauthError" class="form-error">{{ oauthError }}</p>
          <footer><button type="button" class="button button--secondary" @click="oauthAccount = null">取消</button><button v-if="oauthForm.flowId" type="button" class="button button--quiet" :disabled="oauthSaving" @click="restartOAuth">重新生成</button><button class="button button--primary" :disabled="oauthSaving || (Boolean(oauthForm.flowId) && !oauthForm.callbackUrl.trim())"><IconLogin2 :size="16" />{{ oauthSaving ? '处理中' : oauthForm.flowId ? '完成授权' : '生成授权链接' }}</button></footer>
        </form>
      </section>
      </div>
    </Transition>

    <Transition name="hub-layer">
      <div v-if="editingSub" class="admin-modal-backdrop account-vault-layer" @click.self="editingSub = null">
      <section class="admin-modal admin-modal--wide hub-layer-panel" role="dialog" aria-modal="true" aria-label="编辑 Sub2API 账号">
        <header><div><span>SUB2API ACCOUNT</span><h2 class="text-balance">编辑号池账号</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="editingSub = null"><IconX :size="18" /></button></header>
        <form class="admin-form" @submit.prevent="saveSub">
          <div class="form-grid"><label><span>账号名称 *</span><input v-model="subForm.name" required maxlength="160"></label><label><span>备注</span><input v-model="subForm.notes" maxlength="2000"></label></div>
          <div class="form-grid form-grid--four"><label><span>并发容量</span><input v-model.number="subForm.concurrency" type="number" min="1"></label><label><span>优先级</span><input v-model.number="subForm.priority" type="number" min="0"></label><label><span>倍率</span><input v-model.number="subForm.rateMultiplier" type="number" min="0" step="0.01"></label><label><span>状态</span><AppSelect v-model="subForm.status"><option value="active">运行中</option><option value="inactive">已停用</option><option value="error">异常</option></AppSelect></label></div>
          <label><span>账号代理</span><AppSelect v-model="subForm.proxyId" :disabled="!editingSub.proxyEditable"><option :value="null">不使用代理（直连）</option><option v-for="item in activeProxies()" :key="item.id" :value="item.id">{{ item.name }} · {{ item.protocol }}://{{ item.host }}:{{ item.port }}</option></AppSelect><small v-if="!editingSub.proxyEditable">影子账号继承主账号代理，不能单独修改。</small></label>
          <fieldset class="group-picker"><legend>所属分组</legend><label v-for="item in groups" :key="item.id"><input v-model="subForm.groupIds" type="checkbox" :value="item.id"><span>{{ item.name }}<small>{{ item.platform }}</small></span></label></fieldset>
              <label class="switch"><input v-model="subForm.schedulable" type="checkbox"><span />{{ subForm.schedulable ? '已启用调度' : '已暂停调度' }}</label>
          <p v-if="subFormError" class="form-error">{{ subFormError }}</p>
          <footer><button class="button button--secondary" type="button" @click="editingSub = null">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存配置' }}</button></footer>
        </form>
      </section>
      </div>
    </Transition>

    <Transition name="hub-layer">
      <div v-if="showExport" class="admin-modal-backdrop account-vault-layer" @click.self="showExport = false">
      <section class="admin-modal vault-security-modal hub-layer-panel" role="dialog" aria-modal="true" aria-label="导出完整账号">
        <header><div><span>SECURITY CHECK</span><h2 class="text-balance">导出完整账号</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showExport = false"><IconX :size="18" /></button></header>
        <form class="admin-form" @submit.prevent="exportAccounts"><div class="vault-security-note"><IconLock :size="18" /><p class="text-pretty">导出文件包含账号密码、Token、2FA 密钥、邮箱验证码链接和完整接码链接。操作会写入审计日志。</p></div><label><span>当前管理员密码</span><input v-model="exportPassword" type="password" required autocomplete="current-password"></label><p v-if="exportError" class="form-error">{{ exportError }}</p><footer><button class="button button--secondary" type="button" @click="showExport = false">取消</button><button class="button button--primary">确认导出</button></footer></form>
      </section>
      </div>
    </Transition>

    <AppConfirmDialog :open="Boolean(deleting)" title="确认删除" :message="deleteMessage(deleting)" :busy="deletingBusy" @close="deleting = null" @confirm="confirmDelete" />
  </div>
</template>

<style scoped>
.account-toolbar { margin-bottom: 12px; }
.account-toolbar > span { margin-left: auto; color: var(--hub-text-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.account-workspace-table { width: 100%; min-width: 1420px; table-layout: auto; }
.account-workspace-table th:nth-child(2) { width: 300px; min-width: 300px; max-width: 300px; }
.account-workspace-table th:nth-child(3) { width: 100px; }
.account-workspace-table th:nth-child(4) { width: 160px; }
.account-workspace-table th:nth-child(5) { width: 250px; }
.account-workspace-table th:nth-child(6) { width: 145px; }
.account-workspace-table th:nth-child(7) { width: 285px; }
.account-workspace-table th:nth-child(8) { width: 220px; }
.account-workspace-table th:nth-child(9) { width: 175px; }
.account-source-badge { text-transform: none; }
.account-added-at { color: var(--hub-text-muted); font-family: var(--hub-font-mono); font-size: .66rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.receiver-table th:nth-child(1) { width: 50px; }
.receiver-table th:nth-child(2) { width: 205px; }
.receiver-table th:nth-child(3) { width: 120px; }
.receiver-table th:nth-child(4) { width: 90px; }
.receiver-table th:nth-child(5) { width: 175px; }
.receiver-table th:nth-child(6) { width: 180px; }
.receiver-table th:nth-child(7) { width: 130px; }
.account-vault-page :is(th.selection-column, td.selection-cell) { width: 50px; min-width: 50px; max-width: 50px; padding-inline: 0; text-align: center; }
.account-vault-page :is(.selection-column, .selection-cell) :is(.row-select, .table-select) { width: 100%; min-height: 32px; display: grid; place-items: center; cursor: pointer; }
.table-primary-cell { min-width: 0; }
.row-select, .table-select { display: inline-flex; align-items: center; cursor: pointer; }
.row-select input, .table-select input { width: 15px; height: 15px; margin: 0; accent-color: var(--hub-accent); }
.account-identity { min-width: 0; display: grid; justify-items: start; gap: 6px; }
.account-badge-row { display: flex; align-items: center; gap: 5px; min-height: 22px; }
.account-email-row { width: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; }
.account-email { min-width: 0; margin-top: 0; display: inline; overflow: hidden; color: var(--hub-text); font-size: 12px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.account-email-link { min-width: 0; display: inline-flex; align-items: center; gap: 5px; overflow: hidden; color: var(--hub-accent-text); font-family: var(--font-mono); font-size: 12px; font-weight: 700; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.account-email-link svg { flex: 0 0 auto; }
.account-email-link span { white-space: nowrap; }
.account-email-link:hover { text-decoration: underline; }
.account-copy-button { width: 18px; height: 18px; display: inline-grid; place-items: center; flex: 0 0 auto; padding: 0; border: 0; color: var(--hub-accent-text); background: transparent; cursor: pointer; }
.account-copy-button:hover { color: var(--hub-accent); }
.password-copy { max-width: 100%; padding: 0; border: 0; display: inline-flex; align-items: center; gap: 5px; overflow: hidden; color: var(--hub-accent-text); background: transparent; font-family: var(--font-mono); font-size: 12px; font-weight: 700; cursor: pointer; }
.password-copy svg { flex: 0 0 auto; }
.password-copy span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.password-copy:hover { text-decoration: underline; }
.pool-status { min-width: 0; display: grid; justify-items: start; gap: 6px; }
.sub-status-line { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
.sub-status-code { color: var(--hub-danger); font-size: 12px; font-variant-numeric: tabular-nums; }
.local-account-status { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.account-kind-badge { color: var(--hub-text-muted); background: var(--hub-solid-surface-hover); }
.record-badge { min-height: 22px; padding: 2px 7px; border: 1px solid var(--hub-line-strong); border-radius: 4px; display: inline-flex; align-items: center; color: var(--hub-text-muted); background: var(--hub-solid-surface-hover); font-size: 11px; font-weight: 800; white-space: nowrap; }
.record-badge[data-tone='active'] { border-color: var(--hub-success-line); color: var(--hub-success); background: var(--hub-success-soft); }
.record-badge[data-tone='sub'], .record-badge[data-tone='plan'] { border-color: var(--hub-accent-line); color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.record-badge[data-tone='cpa'] { border-color: var(--hub-warning-line); color: var(--hub-warning); background: var(--hub-warning-soft); }
.record-badge[data-tone='error'] { border-color: var(--hub-danger-line); color: var(--hub-danger); background: var(--hub-danger-soft); }
.table-value { display: block; font-variant-numeric: tabular-nums; }
.table-muted { color: var(--hub-text-faint); font-size: 11px; }
.compact-switch { position: relative; min-width: 105px; margin-top: 6px; display: grid; grid-template-columns: 30px auto; align-items: center; gap: 6px; cursor: pointer; }
.compact-switch input { position: absolute; left: 0; top: 0; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.compact-switch > span { width: 30px; height: 17px; padding: 2px; border: 1px solid var(--hub-line-strong); border-radius: 10px; background: var(--hub-skeleton-strong); }
.compact-switch > span::after { content: ''; display: block; width: 11px; height: 11px; border-radius: 50%; background: var(--hub-solid-surface); box-shadow: 0 1px 2px rgb(0 0 0 / 20%); }
.compact-switch input:checked + span { border-color: var(--hub-accent); background: var(--hub-accent); }
.compact-switch input:checked + span::after { transform: translateX(13px); }
.compact-switch em { color: var(--hub-text-muted); font-size: 11px; font-style: normal; font-weight: 700; white-space: nowrap; }
.compact-switch.disabled { cursor: wait; opacity: .55; }
.quota-windows { display: grid; gap: 7px; }
.quota-windows > div { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; gap: 3px 8px; }
.quota-window-summary { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.quota-window-stats { min-width: 0; display: flex; align-items: center; gap: 8px; }
.quota-window-stats span { color: var(--hub-text-muted); font-family: var(--hub-font-mono); font-size: 9px; font-variant-numeric: tabular-nums; line-height: 1.35; white-space: nowrap; }
.quota-windows span { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.quota-windows .quota-window-heading { flex: 0 0 auto; justify-content: flex-start; gap: 10px; }
.quota-windows span b { overflow: hidden; color: var(--hub-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.quota-windows span em { color: var(--hub-text-muted); font-size: 11px; font-style: normal; font-variant-numeric: tabular-nums; white-space: nowrap; }
.quota-window-progress { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.quota-windows i { height: 4px; border-radius: 2px; overflow: hidden; background: var(--hub-skeleton-strong); }
.quota-windows i b { height: 100%; display: block; background: var(--hub-accent); }
.quota-windows small { color: var(--hub-text-faint); font-size: 10px; line-height: 1.35; text-align: right; white-space: nowrap; }
.account-sms { min-width: 0; display: grid; gap: 5px; }
.account-sms > div { display: flex; align-items: center; gap: 5px; }
.account-sms-meta { color: var(--hub-text-faint); font-size: 10px; line-height: 1; }
.account-sms-meta svg { color: var(--hub-text-faint); }
.account-sms-meta strong { color: var(--hub-text-muted); font-size: 10px; font-weight: 800; }
.account-sms-meta i { width: 1px; height: 10px; margin-inline: 2px; background: var(--hub-line-strong); }
.account-sms-code-row { min-height: 26px; }
.account-sms-code-row > :first-child { margin-right: auto; }
.account-sms .account-sms-icon { width: var(--hub-icon-button-size-compact); height: var(--hub-icon-button-size-compact); border-radius: 5px; }
.account-sms code { color: var(--hub-accent-text); font-size: 13px; font-weight: 800; }
.account-sms small { max-width: 130px; overflow: hidden; color: var(--hub-text-faint); text-overflow: ellipsis; white-space: nowrap; }
.phone-copy { max-width: 100%; padding: 0; border: 0; display: inline-flex; align-items: center; gap: 5px; overflow: hidden; color: var(--hub-accent-text); background: transparent; font: inherit; font-size: 12px; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.phone-copy:hover { text-decoration: underline; }
.account-row-actions { justify-content: flex-start; flex-wrap: wrap; gap: 4px 9px; }
.account-action-button { padding: 2px 0; border: 0; display: inline-flex; align-items: center; gap: 4px; color: var(--hub-accent-text); background: transparent; font: inherit; font-size: 11px; font-weight: 750; line-height: 1.4; white-space: nowrap; cursor: pointer; }
.account-action-button svg { flex: 0 0 auto; }
.account-action-button:hover { color: var(--hub-accent); text-decoration: none; }
.account-action-button:disabled { cursor: wait; opacity: .5; }
.account-action-button--danger { color: var(--hub-danger); }
.account-action-button--danger:hover { color: var(--hub-danger); }
.account-auth-button { color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.account-empty { gap: 10px; padding: 28px; }
.receiver-table-wrap--page { max-height: none; }
.receiver-phone-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.receiver-count { display: grid; grid-template-columns: 18px auto; align-items: center; justify-content: start; gap: 2px 6px; color: var(--hub-accent-text); }
.receiver-count small { grid-column: 2; color: var(--hub-text-faint); font-size: 11px; }
.receiver-create-modes { margin-bottom: 0; }
.receiver-editor-modal .receiver-editor { border-bottom: 0; }
.receiver-import-input { min-height: 190px; font-family: var(--font-mono); font-size: 11px !important; line-height: 1.65 !important; }
.receiver-import-preview [data-valid='false'] :is(strong, small, code) { color: var(--hub-danger); }
.receiver-editor > .form-error { white-space: pre-line; }
.receiver-editor > footer > span { margin-right: auto; color: var(--hub-text-faint); font-size: 11px; }
.receiver-bindings { border-block: 1px solid var(--hub-line); }
.receiver-bindings > header { min-height: 54px; padding: 9px 2px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.receiver-bindings > header > div { display: flex; align-items: center; gap: 8px; }
.receiver-bindings h3 { font-size: 13px; }
.receiver-bindings header span { color: var(--hub-accent-text); font-size: 12px; font-weight: 800; }
.receiver-bindings header small { color: var(--hub-text-faint); font-size: 11px; }
.receiver-bindings__list { max-height: 230px; overflow-y: auto; }
.receiver-bindings__list > div { min-height: 54px; padding: 8px 2px; border-top: 1px solid var(--hub-line-row); display: grid; grid-template-columns: minmax(0, 1fr) 36px; align-items: center; gap: 10px; }
.receiver-bindings__list > div > span { min-width: 0; display: grid; gap: 3px; }
.receiver-bindings__list strong, .receiver-bindings__list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.receiver-bindings__list strong { color: var(--hub-text); font-size: 12px; }
.receiver-bindings__list small { color: var(--hub-text-faint); font-size: 11px; }
.receiver-bindings__list [data-deleted='true'] strong { color: var(--hub-warning); }
.receiver-bindings__empty { min-height: 84px; border-top: 1px solid var(--hub-line-row); display: grid; place-content: center; justify-items: center; gap: 7px; color: var(--hub-text-faint); font-size: 12px; }
.receiver-manual-binding { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hub-line-row); display: grid; gap: 8px; }
.receiver-manual-binding > div { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 8px; }
.receiver-manual-binding label { display: grid; gap: 4px; }
.receiver-manual-binding label > span { color: var(--hub-text-faint); font-size: 10px; }
.receiver-manual-binding input { min-height: 32px; }
.receiver-manual-binding .form-error { margin: 0; }
.oauth-login-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.import-parse-button { justify-self: start; }
.sub-import-preview { max-height: 220px; border-block: 1px solid var(--hub-line); overflow: auto; }
.sub-import-preview > div { min-height: 48px; padding: 8px 2px; border-bottom: 1px solid var(--hub-line-row); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sub-import-preview > div:last-of-type { border-bottom: 0; }
.sub-import-preview span { min-width: 0; display: grid; gap: 3px; }
.sub-import-preview strong, .sub-import-preview small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-import-preview small { color: var(--hub-text-faint); font-size: 11px; }
.sub-import-preview code { flex: 0 0 auto; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.vault-upload-form > footer > span { margin-right: auto; color: var(--hub-text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.credential-converter-form > footer > span { margin-right: auto; color: var(--hub-text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.credential-converter-source { display: grid; gap: 15px; }
.credential-converter-drop { min-height: 122px; }
.conversion-summary { min-height: 60px; padding: 10px 0; border-block: 1px solid var(--hub-line); display: grid; grid-template-columns: repeat(3, minmax(100px, 1fr)) auto; align-items: center; gap: 12px; }
.conversion-summary > span { min-width: 0; display: grid; gap: 3px; }
.conversion-summary strong { color: var(--hub-text); font-size: 17px; }
.conversion-summary small { color: var(--hub-text-faint); font-size: 11px; }
.conversion-list { max-height: min(38dvh, 390px); border-block: 1px solid var(--hub-line); overflow-y: auto; }
.conversion-list article { min-height: 86px; padding: 12px 2px; border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: 26px minmax(190px, 1fr) auto minmax(210px, .65fr); align-items: center; gap: 8px 14px; }
.conversion-list article:last-child { border-bottom: 0; }
.conversion-list article[data-selected='false'] { opacity: .58; }
.conversion-select { display: grid !important; place-items: center; }
.conversion-select input { width: 16px; min-height: 16px; accent-color: var(--hub-accent); }
.conversion-identity { min-width: 0; display: grid; gap: 3px; }
.conversion-identity strong, .conversion-identity code, .conversion-identity small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conversion-identity strong { color: var(--hub-text); font-size: 13px; }
.conversion-identity code { font-size: 12px; }
.conversion-identity small { color: var(--hub-text-faint); font-size: 11px; }
.conversion-flags { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.conversion-targets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.conversion-targets > label { min-height: 40px; padding: 6px 8px; border: 1px solid var(--hub-line-strong); border-radius: 5px; display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; gap: 7px; background: var(--hub-input-bg); cursor: pointer; }
.conversion-targets > label:has(input:checked) { border-color: var(--hub-accent-line); color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.conversion-targets > label.disabled { cursor: not-allowed; opacity: .55; }
.conversion-targets input { width: 15px; min-height: 15px; accent-color: var(--hub-accent); }
.conversion-targets label > span { display: grid; gap: 1px; font-size: 11px; }
.conversion-targets small { color: var(--hub-accent-text); font-size: 9px; }
.conversion-warning { grid-column: 2 / -1; overflow-wrap: anywhere; color: var(--hub-warning); font-size: 10px; line-height: 1.45; }
.conversion-settings { padding-block: 4px; display: grid; gap: 14px; }
.conversion-settings > header { min-height: 38px; border-bottom: 1px solid var(--hub-line-row); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.conversion-settings h3 { font-size: 13px; }
.conversion-settings header span { color: var(--hub-text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.conversion-skipped { padding: 9px 11px; border-left: 3px solid var(--hub-warning); color: var(--hub-warning); background: var(--hub-warning-soft); font-size: 11px; line-height: 1.5; }

@media (max-width: 720px) {
  .account-vault-page .admin-header-actions { width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .account-vault-page .admin-header-actions .button { min-width: 0; justify-content: center; }
  .account-toolbar { align-items: stretch; flex-wrap: wrap; }
  .account-toolbar .admin-search { flex-basis: 100%; }
  .account-toolbar > span { margin-left: 0; margin-right: auto; }
  .conversion-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .conversion-summary .button { grid-column: 1 / -1; }
  .conversion-list article { grid-template-columns: 24px minmax(0, 1fr); }
  .conversion-flags, .conversion-targets, .conversion-warning { grid-column: 2; }
  .conversion-targets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .credential-converter-form > footer { align-items: stretch; flex-wrap: wrap; }
  .credential-converter-form > footer > span { width: 100%; }
  .credential-converter-form > footer .button { flex: 1; }
}

/* Account operations follow the same quiet, layered workspace language as the users page. */
.account-vault-page {
  width: min(100% - calc(var(--hub-page-gutter) * 2), var(--hub-content-max));
  padding-top: 2.5rem;
}
.account-vault-page .admin-page__header {
  min-height: 90px;
  margin-bottom: 1.35rem;
  align-items: flex-end;
}
.account-vault-page .admin-page__header h1 { font-size: 2.2rem; }
.account-vault-page .admin-page__header p { max-width: 48rem; }
.account-vault-page .admin-header-actions { display: flex; align-items: center; gap: .6rem; }
.account-vault-page .admin-header-actions .app-button { min-height: 2.45rem; }
.account-vault-page > .admin-page-tabs {
  margin-bottom: .75rem;
  padding-inline: .25rem;
  border-bottom-color: var(--hub-line);
}
.account-vault-page > .admin-page-tabs button { min-height: 2.75rem; gap: .45rem; }
.account-vault-page > .admin-page-tabs button[aria-selected='true'] { color: var(--hub-accent-text); border-bottom-color: var(--hub-accent); }
.account-vault-page .account-toolbar.glass-panel {
  position: relative;
  z-index: var(--hub-z-local-sticky);
  min-height: 4.2rem;
  margin-bottom: .75rem;
  padding: .75rem;
  overflow: visible;
  display: grid;
  grid-template-columns: minmax(20rem, 1fr) auto auto;
  align-items: center;
  gap: .65rem;
  border-color: var(--hub-line);
  background: var(--hub-glass);
}
.account-vault-page .account-toolbar .admin-search { width: 100%; min-height: 2.45rem; }
.account-vault-page .account-toolbar .admin-search input { min-height: 2.45rem; }
.account-vault-page .account-toolbar > span { margin: 0; color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .68rem; white-space: nowrap; }
.account-vault-page .account-toolbar > .icon-button { width: 2.45rem; height: 2.45rem; }
.account-vault-page .account-toolbar > .app-button { min-height: 2.45rem; }
.account-vault-page .admin-table-wrap.glass-panel {
  max-width: 100%;
  overflow-x: auto;
  border-color: var(--hub-line);
  border-radius: var(--hub-radius-panel);
  background: var(--hub-glass);
  box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow);
}
.account-vault-page .admin-table { background: transparent; }
.account-vault-page .admin-table th {
  height: 2.9rem;
  color: var(--hub-text-faint);
  background: color-mix(in srgb, var(--hub-glass-strong) 48%, transparent);
  font-size: .66rem;
}
.account-vault-page .admin-table td { min-height: 4.6rem; padding: .9rem 1rem; font-size: .74rem; }
.account-vault-page .admin-table tbody tr { transition: background-color var(--hub-duration-base) ease; }
.account-vault-page .admin-table tbody tr:hover { background: color-mix(in srgb, var(--hub-accent-soft) 70%, transparent); }
.account-vault-page .account-workspace-table { min-width: 70rem; }
.account-vault-page .receiver-table { min-width: 62rem; }
.account-vault-page .account-identity { gap: .42rem; }
.account-vault-page .account-badge-row { gap: .35rem; }
.account-vault-page .record-badge { min-height: 1.35rem; padding: .18rem .42rem; border-radius: 5px; font-size: var(--hub-text-micro); }
.account-vault-page .account-email,
.account-vault-page .account-email-link { font-size: .76rem; }
.account-vault-page .pool-status { gap: .42rem; }
.account-vault-page .table-sub { font-size: .64rem; }
.account-vault-page .table-muted { font-size: .68rem; line-height: 1.45; }
.account-vault-page .account-row-actions { gap: .35rem; }
.account-vault-page .account-action-button {
  min-height: 1.8rem;
  padding: 0 .48rem;
  border: 1px solid var(--hub-line);
  border-radius: 5px;
  color: var(--hub-text-muted);
  background: var(--hub-input-bg);
  font-size: .64rem;
  font-weight: var(--hub-weight-medium);
  transition: color var(--hub-duration-base) ease, border-color var(--hub-duration-base) ease, background-color var(--hub-duration-base) ease, transform var(--hub-duration-fast) ease;
}
.account-vault-page .account-action-button:hover:not(:disabled) { border-color: var(--hub-accent-line); color: var(--hub-accent-text); background: var(--hub-accent-soft); text-decoration: none; }
.account-vault-page .account-action-button:active:not(:disabled) { transform: translateY(1px); }
.account-vault-page .account-action-button--danger { color: var(--hub-danger); }
.account-vault-page .account-action-button--danger:hover:not(:disabled) { border-color: var(--hub-danger-line); color: var(--hub-danger); background: var(--hub-danger-soft); }
.account-vault-page .account-empty { min-height: 15rem; padding: 2rem; gap: .6rem; }

.account-vault-layer { padding: 1.5rem; place-items: center; }
.account-vault-layer > .admin-modal {
  width: min(68rem, 100%);
  max-height: min(52rem, calc(100dvh - 3rem));
  overflow: hidden;
  border-color: var(--hub-line-strong);
  border-radius: var(--hub-radius-panel);
  background: var(--hub-solid-surface);
  box-shadow: var(--hub-panel-highlight), var(--hub-panel-shadow);
}
.account-vault-layer > .admin-modal > header {
  min-height: 5.8rem;
  padding: 0 1.4rem;
  border-bottom-color: var(--hub-line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: color-mix(in srgb, var(--hub-solid-surface) 86%, transparent);
  backdrop-filter: var(--hub-blur-panel);
}
.account-vault-layer > .admin-modal > header > div { min-width: 0; }
.account-vault-layer > .admin-modal > header span { color: var(--hub-accent-text); font-size: .62rem; }
.account-vault-layer > .admin-modal > header h2 { margin: .25rem 0 0; color: var(--hub-text); font-size: 1.08rem; font-weight: var(--hub-weight-semibold); }
.account-vault-layer > .admin-modal > .admin-page-tabs { flex: 0 0 auto; margin: .75rem 1.4rem 0; padding-inline: .15rem; border-bottom-color: var(--hub-line); }
.account-vault-layer > .admin-modal > .admin-page-tabs button { min-height: 2.45rem; }
.account-vault-layer > .admin-modal > .admin-page-tabs--embedded { margin: .65rem 1.4rem 0; border-color: var(--hub-line); }
.account-vault-layer > .admin-modal > .admin-form {
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem 1.4rem 0;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}
.account-vault-layer > .admin-modal > .admin-form label { gap: .45rem; color: var(--hub-text-muted); font-size: .72rem; font-weight: var(--hub-weight-medium); }
.account-vault-layer > .admin-modal > .admin-form :is(input, select, textarea) { min-height: 2.45rem; border-radius: 7px; font-size: .78rem; }
.account-vault-layer > .admin-modal > .admin-form textarea { padding-block: .65rem; }
.account-vault-layer > .admin-modal > .admin-form > footer {
  position: sticky;
  bottom: 0;
  z-index: var(--hub-z-local-raised);
  margin: .25rem -1.4rem 0;
  padding: .9rem 1.4rem;
  border-top: 1px solid var(--hub-line);
  background: color-mix(in srgb, var(--hub-solid-surface) 90%, transparent);
  box-shadow: 0 -12px 30px rgb(5 5 9 / 12%);
  backdrop-filter: var(--hub-blur-panel);
}
.account-vault-layer > .admin-modal > .admin-form > footer > span,
.account-vault-layer .button--primary { color: var(--hub-accent-text); border-color: var(--hub-accent-line); background: linear-gradient(180deg, color-mix(in srgb, var(--hub-accent) 24%, transparent), color-mix(in srgb, var(--hub-accent) 14%, transparent)); box-shadow: var(--hub-panel-highlight), 0 10px 28px rgb(77 50 142 / 12%); }
.account-vault-layer .button--primary:hover:not(:disabled) { color: var(--hub-accent-text); border-color: var(--hub-accent); background: var(--hub-accent-soft); }
.account-vault-layer .button--secondary { color: var(--hub-button-secondary-fg); border-color: var(--hub-line-strong); background: var(--hub-button-secondary-bg); }
.account-vault-layer .button--secondary:hover:not(:disabled) { border-color: var(--hub-accent-line); background: var(--hub-accent-soft); }
.account-vault-layer .vault-create-modes { width: auto; margin: .75rem 1.4rem 0; }
.account-vault-layer .form-grid { gap: .85rem; }
.account-vault-layer .form-error { margin: 0; padding: .7rem .8rem; border-radius: 6px; font-size: .7rem; white-space: pre-line; }
.account-vault-layer .group-picker { gap: .45rem; padding: .7rem; border-color: var(--hub-line); border-radius: 7px; background: color-mix(in srgb, var(--hub-glass) 50%, transparent); }
.account-vault-layer .group-picker span { min-height: 2.45rem; padding: .45rem .6rem; border-color: var(--hub-line); border-radius: 6px; font-size: .68rem; }
.account-vault-layer .group-picker input:checked + span { color: var(--hub-on-accent); border-color: var(--hub-accent); background: var(--hub-accent); }
.account-vault-layer .switch { min-height: 2.45rem; }
.account-vault-layer .credential-drop { position: relative; min-height: 8rem; padding: 1rem; border-color: var(--hub-accent-line); border-style: dashed; border-radius: 7px; background: var(--hub-input-bg); cursor: pointer; transition: color var(--hub-duration-fast) ease, border-color var(--hub-duration-fast) ease, background-color var(--hub-duration-fast) ease; }
.account-vault-layer .credential-drop--compact { min-height: 6.5rem; }
.account-vault-layer > .account-editor-modal > .account-editor-form .credential-drop > input { position: absolute; width: 1px; height: 1px; min-height: 1px; padding: 0; overflow: hidden; border: 0; opacity: 0; clip-path: inset(50%); }
.account-vault-layer .credential-drop-copy { min-width: 0; display: grid; place-items: center; gap: .35rem; color: var(--hub-text-muted); text-align: center; }
.account-vault-layer .credential-drop-copy svg { color: var(--hub-accent-text); }
.account-vault-layer .credential-drop-copy strong { color: var(--hub-text); font-size: .72rem; font-weight: var(--hub-weight-medium); }
.account-vault-layer .credential-drop-copy small { max-width: 100%; overflow: hidden; color: var(--hub-text-faint); font-size: .61rem; font-weight: var(--hub-weight-regular); text-overflow: ellipsis; white-space: nowrap; }
.account-vault-layer .credential-drop:hover { border-color: var(--hub-accent-line); background: var(--hub-accent-soft); }
.account-vault-layer .credential-drop:has(> input:focus-visible) { outline: 2px solid var(--hub-focus-ring); outline-offset: 2px; }
.account-vault-layer .sub-import-preview,
.account-vault-layer .conversion-list,
.account-vault-layer .receiver-bindings__list { border-color: var(--hub-line); border-radius: 6px; }
.account-vault-layer .conversion-list { max-height: min(38dvh, 390px); overflow-y: auto; scrollbar-width: thin; }
.account-vault-layer .conversion-list article { min-height: 5rem; padding: .75rem .25rem; border-bottom-color: var(--hub-line-row); }
.account-vault-layer .conversion-list article[data-selected='false'] { opacity: .56; }
.account-vault-layer .conversion-summary { min-height: 4.2rem; padding: .65rem 0; border-color: var(--hub-line); }
.account-vault-layer .conversion-summary strong { font-size: 1.15rem; }
.account-vault-layer .oauth-account-summary { padding: .75rem; border: 1px solid var(--hub-line); border-radius: 7px; background: var(--hub-glass); }
.account-vault-layer .oauth-account-summary span { min-height: 3.4rem; padding: .55rem .7rem; border-color: var(--hub-line-row); }
.account-vault-layer .oauth-account-summary strong { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: .76rem; }
.account-vault-layer .oauth-account-summary small { color: var(--hub-text-faint); font-size: .62rem; }
.account-vault-layer .oauth-link-section { border-color: var(--hub-line); border-radius: 7px; background: var(--hub-glass); }
.account-vault-layer .oauth-link-section > header { min-height: 3.8rem; padding: .7rem .8rem; border-bottom-color: var(--hub-line); }
.account-vault-layer .oauth-link-section > input { margin: .75rem; width: calc(100% - 1.5rem); }
.account-vault-layer .receiver-bindings { border-block-color: var(--hub-line); }
.account-vault-layer .receiver-bindings > header { min-height: 3.8rem; padding: .65rem .1rem; }
.account-vault-layer .receiver-bindings__list > div { min-height: 3.7rem; border-top-color: var(--hub-line-row); }

.account-vault-layer > .account-editor-modal {
  height: min(44rem, calc(100dvh - 3rem));
  max-height: calc(100dvh - 3rem);
  display: flex;
  flex-direction: column;
}
.account-editor-heading { min-width: 0; display: flex; align-items: center; gap: .85rem; }
.account-editor-title-icon { width: 2.65rem; height: 2.65rem; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--hub-accent-line); border-radius: 7px; color: var(--hub-accent-text); background: var(--hub-accent-soft); box-shadow: var(--hub-panel-highlight); }
.account-vault-layer > .account-editor-modal > .account-editor-header { min-height: 6.2rem; flex: 0 0 auto; }
.account-editor-heading p { margin: .25rem 0 0; color: var(--hub-text-faint); font-size: .66rem; }
.account-editor-main > .account-editor-tabs {
  width: max-content;
  max-width: 100%;
  margin: 0;
  padding: 3px;
  justify-self: start;
  overflow-x: auto;
}
.account-editor-tabs button { min-width: max-content; padding-inline: .85rem; flex: 0 0 auto; }
.account-vault-layer > .account-editor-modal > .account-editor-form {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  gap: 0;
}
.account-editor-layout { min-height: 0; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(23rem, .8fr); overflow: hidden; }
.account-editor-main,
.account-editor-aside { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; }
.account-editor-main { padding: 1.25rem 1.4rem 1.15rem; display: grid; align-content: start; gap: 1rem; }
.account-editor-aside { padding: 1.25rem; border-left: 1px solid var(--hub-line); display: grid; align-content: start; gap: 1rem; background: linear-gradient(180deg, var(--hub-accent-soft), color-mix(in srgb, var(--hub-glass) 70%, transparent)); }
.account-editor-section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; padding-bottom: .75rem; border-bottom: 1px solid var(--hub-line); }
.account-editor-section-heading span,
.account-editor-aside-heading > div > span { color: var(--hub-accent-text); font-family: var(--hub-font-mono); font-size: .6rem; }
.account-editor-section-heading h3,
.account-editor-aside-heading h3 { margin: .2rem 0 0; color: var(--hub-text); font-size: .86rem; font-weight: var(--hub-weight-semibold); }
.account-editor-section-heading small { color: var(--hub-text-faint); font-size: .62rem; }
.account-editor-aside-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .65rem; padding-bottom: .8rem; border-bottom: 1px solid var(--hub-line); }
.account-editor-aside-heading p { margin: .25rem 0 0; color: var(--hub-text-faint); font-size: .62rem; text-transform: uppercase; }
.account-editor-aside-heading > code { padding: .25rem .38rem; border: 1px solid var(--hub-line); border-radius: 4px; color: var(--hub-text-muted); font-family: var(--hub-font-mono); font-size: .58rem; }
.account-editor-aside-icon { width: 2.1rem; height: 2.1rem; display: grid; place-items: center; border: 1px solid var(--hub-accent-line); border-radius: 6px; color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.account-editor-main > .form-grid { margin: 0; }
.account-editor-main > label,
.account-editor-aside > label { display: grid; }
.account-editor-main textarea { min-height: 7.5rem; }
.delivery-config-grid { display: grid; grid-template-columns: minmax(12rem, .45fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
.delivery-config-grid > label { display: grid; }
.delivery-field-picker,
.delivery-field-order { min-width: 0; margin: 0; padding: 0; border: 0; }
.delivery-field-picker legend,
.delivery-field-order legend { margin-bottom: .45rem; color: var(--hub-text-muted); font-size: .7rem; font-weight: var(--hub-weight-medium); }
.delivery-field-picker > div { display: flex; flex-wrap: wrap; gap: .42rem; }
.delivery-field-picker label { position: relative; cursor: pointer; }
.delivery-field-picker input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.delivery-field-picker label > span { min-height: 2rem; padding: .35rem .55rem; border: 1px solid var(--hub-line); border-radius: 5px; display: inline-flex; align-items: center; color: var(--hub-text-muted); font-size: .65rem; background: var(--hub-glass); }
.delivery-field-picker input:checked + span { border-color: var(--hub-accent-line); color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.delivery-field-picker input:focus-visible + span { outline: 2px solid var(--hub-focus-ring); outline-offset: 2px; }
.delivery-field-picker input:disabled + span { cursor: default; opacity: .72; }
.delivery-field-order { padding: .75rem; border: 1px solid var(--hub-line); border-radius: 7px; background: color-mix(in srgb, var(--hub-glass) 55%, transparent); }
.delivery-field-order ol { margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .42rem; list-style: none; }
.delivery-field-order li { min-width: 8rem; min-height: 2.2rem; padding: .3rem .38rem; border: 1px solid var(--hub-line); border-radius: 5px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: .3rem; background: var(--hub-glass-strong); }
.delivery-field-order li > code { color: var(--hub-text-faint); font-size: .58rem; }
.delivery-field-order li > span { color: var(--hub-text); font-size: .64rem; }
.delivery-field-order button { width: 1.45rem; height: 1.45rem; padding: 0; border: 0; border-radius: 4px; display: grid; place-items: center; color: var(--hub-text-muted); background: transparent; }
.delivery-field-order button:hover:not(:disabled) { color: var(--hub-text); background: var(--hub-glass-hover); }
.delivery-field-order button:disabled { opacity: .28; }
.delivery-field-order > small { margin-top: .55rem; display: block; color: var(--hub-text-faint); font-size: .62rem; }
.delivery-configuration-error { margin: 0; }
.account-editor-aside label > small { color: var(--hub-text-faint); font-size: .62rem; font-weight: var(--hub-weight-regular); line-height: 1.5; }
.account-editor-switches { display: grid; gap: .55rem; }
.account-editor-switches .switch { width: 100%; padding: .45rem .55rem; border: 1px solid var(--hub-line); border-radius: 7px; background: color-mix(in srgb, var(--hub-glass) 52%, transparent); }
.account-editor-empty { min-height: 9rem; display: grid; place-content: center; justify-items: center; gap: .55rem; color: var(--hub-text-faint); font-size: .7rem; text-align: center; }
.account-editor-file-state { min-height: 9rem; display: grid; place-content: center; justify-items: center; gap: .25rem; color: var(--hub-text-faint); }
.account-editor-file-state strong { color: var(--hub-text); font-family: var(--hub-font-mono); font-size: 2rem; font-weight: var(--hub-weight-semibold); }
.account-editor-file-state span { font-size: .68rem; }
.account-editor-aside .sub-import-preview,
.account-editor-aside .vault-delivery-preview { max-height: none; overflow: visible; border-color: var(--hub-line); }
.account-editor-aside .vault-delivery-preview > div { grid-template-columns: minmax(0, 1fr) 7.5rem; }
.account-editor-aside .form-grid--four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.account-editor-main .conversion-list { max-height: none; overflow: visible; }
.account-editor-main .conversion-list article { grid-template-columns: 24px minmax(0, 1fr); }
.account-editor-main .conversion-flags,
.account-editor-main .conversion-targets,
.account-editor-main .conversion-warning { grid-column: 2; }
.account-editor-main .conversion-targets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.account-editor-main .conversion-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.account-editor-main .conversion-summary .app-button { grid-column: 1 / -1; justify-self: start; }
.account-editor-aside .conversion-settings { padding: 0; }
.account-editor-aside .group-picker { max-height: 10rem; overflow-y: auto; }
.account-vault-layer > .account-editor-modal > .account-editor-form > .account-editor-message { margin: .75rem 1.4rem 0; }
.account-vault-layer > .account-editor-modal > .account-editor-form > .account-editor-footer {
  position: relative;
  bottom: auto;
  z-index: var(--hub-z-local-raised);
  margin: 0;
  padding: .9rem 1.4rem;
  border-top: 1px solid var(--hub-line);
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: .6rem;
  background: color-mix(in srgb, var(--hub-solid-surface) 84%, transparent);
  box-shadow: 0 -12px 30px rgb(5 5 9 / 12%);
  backdrop-filter: var(--hub-blur-panel);
}
.account-editor-footer > span { margin-right: auto; color: var(--hub-text-faint); font-family: var(--hub-font-mono); font-size: .64rem; }

@media (max-width: 820px) {
  .account-vault-layer > .account-editor-modal { height: calc(100dvh - 3rem); }
  .account-vault-layer > .account-editor-modal > .account-editor-form { display: block; overflow-y: auto; }
  .account-editor-layout { display: block; overflow: visible; }
  .account-editor-main,
  .account-editor-aside { overflow: visible; }
  .account-editor-aside { min-height: 18rem; border-top: 1px solid var(--hub-line); border-left: 0; }
  .delivery-config-grid { grid-template-columns: 1fr; }
  .account-vault-layer > .account-editor-modal > .account-editor-form > .account-editor-footer { position: sticky; bottom: 0; }
}

@media (max-width: 720px) {
  .account-vault-page { padding-top: 1.75rem; }
  .account-vault-page .admin-page__header { align-items: stretch; flex-direction: column; gap: 1rem; }
  .account-vault-page .admin-page__header h1 { font-size: 1.85rem; }
  .account-vault-page .admin-header-actions { width: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .account-vault-page .admin-header-actions .app-button { min-width: 0; justify-content: center; }
  .account-vault-page .account-toolbar.glass-panel { grid-template-columns: 1fr auto; align-items: center; }
  .account-vault-page .account-toolbar .admin-search { grid-column: 1 / -1; }
  .account-vault-page .account-toolbar > span { justify-self: start; }
  .account-vault-page .account-toolbar > .icon-button { justify-self: end; }
  .account-vault-page .account-toolbar > .app-button { grid-column: 1 / -1; justify-self: stretch; }
  .account-vault-page .account-workspace-table-wrap,
  .account-vault-page .receiver-table-wrap { border-radius: var(--hub-radius-panel); }
  .account-vault-page .account-workspace-table-wrap,
  .account-vault-page .receiver-table-wrap { overflow: visible; }
  .account-vault-page .account-workspace-table,
  .account-vault-page .receiver-table,
  .account-vault-page .account-workspace-table tbody,
  .account-vault-page .receiver-table tbody,
  .account-vault-page .account-workspace-table tr,
  .account-vault-page .receiver-table tr,
  .account-vault-page .account-workspace-table td,
  .account-vault-page .receiver-table td { display: block; width: 100%; }
  .account-vault-page .account-workspace-table thead,
  .account-vault-page .receiver-table thead { display: none; }
  .account-vault-page .account-workspace-table tr,
  .account-vault-page .receiver-table tr { position: relative; padding: 1rem; border-bottom: 1px solid var(--hub-line); }
  .account-vault-page .account-workspace-table td,
  .account-vault-page .receiver-table td { min-height: 0; display: grid; grid-template-columns: 7rem minmax(0, 1fr); align-items: center; gap: .75rem; padding: .55rem 0; border: 0; }
  .account-vault-page .account-workspace-table td::before,
  .account-vault-page .receiver-table td::before { content: attr(data-label); color: var(--hub-text-faint); font-size: .66rem; }
  .account-vault-page .account-workspace-table td.selection-cell,
  .account-vault-page .receiver-table td.selection-cell { position: absolute; z-index: 1; top: .65rem; right: .65rem; width: 50px; min-width: 50px; padding: 0; display: grid; place-items: center; border: 0; }
  .account-vault-page .account-workspace-table td.selection-cell::before,
  .account-vault-page .receiver-table td.selection-cell::before { display: none; }
  .account-vault-page .account-workspace-table td:nth-child(2),
  .account-vault-page .receiver-table td:nth-child(2) { display: block; padding-top: 0; padding-right: 3rem; padding-bottom: .9rem; border-bottom: 1px solid var(--hub-line); }
  .account-vault-page .account-workspace-table td:nth-child(2)::before,
  .account-vault-page .receiver-table td:nth-child(2)::before { display: none; }
  .account-vault-page .account-workspace-table td:last-child,
  .account-vault-page .receiver-table td:last-child { display: flex; justify-content: flex-end; margin-top: .35rem; padding-top: .8rem; border-top: 1px solid var(--hub-line); }
  .account-vault-page .account-workspace-table td:last-child::before,
  .account-vault-page .receiver-table td:last-child::before { margin-right: auto; }
  .account-vault-page .account-workspace-table tr:has(td[colspan]) td,
  .account-vault-page .receiver-table tr:has(td[colspan]) td { display: block; }
  .account-vault-page .account-workspace-table tr:has(td[colspan]) td::before,
  .account-vault-page .receiver-table tr:has(td[colspan]) td::before { display: none; }
  .account-vault-page .account-workspace-table { min-width: 0; }
  .account-vault-page .receiver-table { min-width: 0; }
  .account-vault-page .account-identity { min-width: 0; }
  .account-vault-page .account-email-row { width: 100%; min-width: 0; }
  .account-vault-page .account-email { max-width: none; overflow: visible; text-overflow: clip; white-space: nowrap; }
  .account-vault-page .account-email-link { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .account-vault-page .account-row-actions { justify-content: flex-start; }
  .account-vault-page .receiver-code--table { min-width: 0; }
  .account-vault-layer { padding: .65rem; place-items: center; }
  .account-vault-layer > .admin-modal { width: 100%; max-height: calc(100dvh - 1.3rem); }
  .account-vault-layer > .admin-modal > header { min-height: 4.5rem; padding-inline: 1rem; }
  .account-vault-layer > .admin-modal > .admin-form { padding: 1rem 1rem 0; }
  .account-vault-layer > .admin-modal > .admin-form > footer { margin-inline: -1rem; padding-inline: 1rem; flex-wrap: wrap; }
  .account-vault-layer > .admin-modal > .admin-page-tabs,
  .account-vault-layer .vault-create-modes { margin-inline: 1rem; }
  .account-vault-layer > .account-editor-modal { height: calc(100dvh - 1.3rem); }
  .account-vault-layer > .account-editor-modal > .account-editor-form { padding: 0; }
  .account-editor-main,
  .account-editor-aside { padding: 1rem; }
  .account-vault-layer > .account-editor-modal > .account-editor-form > .account-editor-message { margin-inline: 1rem; }
  .account-vault-layer > .account-editor-modal > .account-editor-form > .account-editor-footer { padding-inline: 1rem; flex-wrap: wrap; }
  .account-editor-footer > span { width: 100%; }
  .account-vault-layer .form-grid,
  .account-vault-layer .form-grid--four { grid-template-columns: 1fr; }
  .account-vault-layer .conversion-list article { grid-template-columns: 24px minmax(0, 1fr); }
  .account-vault-layer .conversion-flags,
  .account-vault-layer .conversion-targets,
  .account-vault-layer .conversion-warning { grid-column: 2; }
}
</style>
