<script setup lang="ts">
import {
  IconAddressBook,
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
  ACCOUNT_VAULT_STATUSES,
  type AccountDeliveryFormat,
  type AccountSub2ApiPoolStatus,
  type AccountTotpCodeResult,
  type AccountVaultStatus,
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
type DeleteTarget =
  | { kind: 'vault'; item: AccountVaultView }
  | { kind: 'sub'; item: SubAccountManagementView }
  | { kind: 'cpa'; item: CpaAuthFileView }
  | { kind: 'receiver'; item: SmsReceiverView }
  | { kind: 'binding'; receiver: SmsReceiverView; account: SmsReceiverView['accounts'][number] }

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
const managingCpaFiles = ref<CpaAuthFileView[] | null>(null)
const cpaManagerError = ref('')

const showForm = ref(false)
const editing = ref<AccountVaultView | null>(null)
const createMode = ref<'manual' | 'delivery'>('manual')
const manualCreateMode = ref<'form' | 'upload' | 'convert'>('form')
const uploadPool = ref<'sub2api' | 'cpa'>('sub2api')
const saving = ref(false)
const formError = ref('')
const emailCodeUrlTouched = ref(false)
const totpSecretTouched = ref(false)
const deliveryText = ref('')
const deliveryFormat = ref<AccountDeliveryFormat | ''>('')
const deliveryImporting = ref(false)
const deliveryError = ref('')
const form = reactive({
  email: '',
  displayName: '',
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
    const key = identity(item.name)
    if (key && !subByIdentity.has(key)) subByIdentity.set(key, item)
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
    const cpaFiles = takeCpaFiles([vault.email, vault.displayName, sub?.name])
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
        cpaFiles: takeCpaFiles([sub.name]),
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
  return rows
})

const filteredRows = computed(() => {
  const needle = search.value.trim().toLowerCase()
  if (!needle) return unifiedRows.value
  return unifiedRows.value.filter(({ vault, sub, cpaFiles }) => `${vault?.email || ''} ${vault?.displayName || ''} ${vault?.smsReceiver?.phone || ''} ${vault?.remark || ''} ${sub?.name || ''} ${sub?.platform || ''} ${sub?.type || ''} ${sub?.groupNames.join(' ') || ''} ${cpaFiles.map(item => `${item.name} ${item.account || ''} ${item.provider}`).join(' ')}`.toLowerCase().includes(needle))
})

const filteredReceivers = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const items = receiverData.value?.items || []
  return needle ? items.filter(item => `${item.phone} ${item.providerHost} ${item.note || ''} ${item.accounts.map(account => account.email).join(' ')}`.toLowerCase().includes(needle)) : items
})

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

const deliveryFormats: Record<AccountDeliveryFormat, { label: string; placeholder: string; fields: number }> = {
  email_code_url: { label: '邮箱 + 邮箱验证码链接', placeholder: '邮箱----邮箱验证码链接', fields: 2 },
  tokens: { label: '邮箱 + 密码 + AT + RT', placeholder: '邮箱----密码----AT----RT', fields: 4 },
  password_totp: { label: '邮箱 + 密码 + 2FA 密钥', placeholder: '邮箱----密码----Base32密钥', fields: 3 }
}
const selectedDeliveryFormat = computed(() => deliveryFormat.value ? deliveryFormats[deliveryFormat.value] : null)
const deliveryPreview = computed(() => {
  if (!deliveryFormat.value) return []
  const selected = deliveryFormats[deliveryFormat.value]
  return deliveryText.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const fields = line.split('----').map(field => field.trim())
    const validEmail = /^\S+@\S+\.\S+$/.test(fields[0] || '')
    const validFields = fields.length === selected.fields && fields.slice(1).every(Boolean)
    const detailValid = deliveryFormat.value === 'email_code_url'
      ? /^https?:\/\//i.test(fields[1] || '')
      : deliveryFormat.value === 'password_totp'
        ? /^[A-Z2-7\s=]+$/i.test(fields[2] || '')
        : true
    const valid = validEmail && validFields && detailValid
    return { index, email: validEmail ? fields[0]! : '邮箱格式错误', kind: valid ? selected.label : '格式错误', valid }
  })
})

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

function subHasAuthFailure(row: UnifiedAccountRow) {
  const detail = [row.sub?.errorMessage, row.quota?.error, row.quota?.probeError?.message].filter(Boolean).join(' ')
  return /\b(?:401|403)\b|token\s+revoked|invalid(?:ated)?\s+oauth|unauthori[sz]ed/i.test(detail)
}

function subIsRateLimited(row: UnifiedAccountRow) {
  return Boolean(row.quota?.windows.some((windowItem) => {
    if (windowItem.remainingPercent !== null) return windowItem.remainingPercent <= 0
    return windowItem.used !== null && windowItem.limit !== null && windowItem.limit > 0 && windowItem.used >= windowItem.limit
  }))
}

function subStatusLabel(row: UnifiedAccountRow) {
  if (!row.sub) return ''
  if (subHasAuthFailure(row)) return '认证失效'
  if (row.quota?.quotaStatus === 'error') return '检测失败'
  if (subIsRateLimited(row)) return '已限流'
  return localizedStatus(row.sub.status)
}

function subStatusTone(row: UnifiedAccountRow) {
  if (subHasAuthFailure(row) || row.quota?.quotaStatus === 'error') return 'error'
  if (subIsRateLimited(row)) return 'pending'
  return statusTone(row.sub?.status || 'unknown')
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

function smsMessageSummary(result: SmsCodeResult) {
  return result.message.split('|', 1)[0]?.trim() || '暂无新验证码'
}

function accountEmail(row: UnifiedAccountRow) {
  return row.vault?.email
    || row.sub?.name
    || row.cpaFiles[0]?.account
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

function openCpaManager(files: CpaAuthFileView[]) {
  managingCpaFiles.value = [...files]
  cpaManagerError.value = ''
}

function syncCpaManager(previousIds: string[]) {
  const filesById = new Map(managedCpaFiles.value.map(item => [item.id, item]))
  const current = previousIds.map(id => filesById.get(id)).filter((item): item is CpaAuthFileView => Boolean(item))
  managingCpaFiles.value = current.length ? current : null
}

async function verifyCpa(item: CpaAuthFileView) {
  cpaMutating[item.id] = true
  cpaManagerError.value = ''
  try {
    const result = await $fetch<{ modelCount: number }>(`/api/admin/upstreams/cpa/auth-files/${item.id}/verify`, { method: 'POST' })
    await refreshCpa()
    syncCpaManager(managingCpaFiles.value?.map(file => file.id) || [item.id])
    showToast(`CPA 验活通过，可用模型 ${result.modelCount} 个`, 'success')
  } catch (value) {
    cpaManagerError.value = failure(value, 'CPA 认证文件验活失败')
  } finally {
    cpaMutating[item.id] = false
  }
}

async function toggleCpa(item: CpaAuthFileView) {
  const openIds = managingCpaFiles.value?.map(file => file.id) || [item.id]
  cpaMutating[item.id] = true
  cpaManagerError.value = ''
  try {
    await $fetch(`/api/admin/upstreams/cpa/auth-files/${item.id}`, {
      method: 'PATCH', body: { disabled: !item.disabled }
    })
    await refreshCpa()
    syncCpaManager(openIds)
    showToast(item.disabled ? 'CPA 认证文件已启用' : 'CPA 认证文件已停用', 'success')
  } catch (value) {
    cpaManagerError.value = failure(value, '修改 CPA 认证文件状态失败')
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
    email: '', displayName: '', status: 'Codex', password: '', emailCodeUrl: '', totpSecret: '', smsReceiverId: '', remark: ''
  })
  emailCodeUrlTouched.value = false
  totpSecretTouched.value = false
  formError.value = ''
}

function openCreate() {
  editing.value = null
  createMode.value = 'manual'
  manualCreateMode.value = 'form'
  uploadPool.value = 'sub2api'
  resetForm()
  resetUploadForm()
  resetConversionForm()
  deliveryText.value = ''
  deliveryFormat.value = ''
  deliveryError.value = ''
  showForm.value = true
}

function openEdit(item: AccountVaultView) {
  editing.value = item
  Object.assign(form, {
    email: item.email,
    displayName: item.displayName || '',
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
  createMode.value = 'manual'
  manualCreateMode.value = 'form'
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
  if (!deliveryFormat.value) {
    deliveryError.value = '请先选择发货格式'
    return
  }
  if (!deliveryPreview.value.length) {
    deliveryError.value = '请输入发货内容'
    return
  }
  deliveryImporting.value = true
  try {
    const result = await $fetch<{ created: number; skipped: number; failed: Array<{ index: number; email: string; message: string }> }>('/api/admin/account-vault/delivery-import', {
      method: 'POST', body: { text: deliveryText.value, format: deliveryFormat.value }
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
  showReceiverForm.value = true
}

function openReceiverEdit(item: SmsReceiverView) {
  editingReceiver.value = item
  Object.assign(receiverForm, { phone: item.phone, fetchUrl: '', note: item.note || '', active: item.status === 'active' })
  receiverError.value = ''
  showReceiverForm.value = true
}

function closeReceiverForm() {
  if (receiverSaving.value) return
  showReceiverForm.value = false
  editingReceiver.value = null
  receiverImportText.value = ''
  receiverError.value = ''
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
  if (target.kind === 'vault') return `删除本地账号“${target.item.email}”？已进入 Sub2API 的账号不会随之删除，接码历史名额会保留。`
  if (target.kind === 'sub') return `永久删除 Sub2API 账号“${target.item.name}”？只有当前并发为 0 时才会执行。`
  if (target.kind === 'cpa') return `永久删除 CPA 认证文件“${target.item.name}”？删除前必须先停用，此操作无法恢复。`
  if (target.kind === 'receiver') return `永久删除接码手机号“${target.item.phone}”？`
  return target.account.deleted
    ? `释放手机号为已删除账号“${target.account.email}”保留的名额？`
    : `解除账号“${target.account.email}”与手机号“${target.receiver.phone}”的绑定？`
}

async function confirmDelete() {
  const target = deleting.value
  if (!target) return
  deletingBusy.value = true
  try {
    if (target.kind === 'vault') {
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
      const openIds = managingCpaFiles.value?.map(file => file.id) || []
      await $fetch(`/api/admin/upstreams/cpa/auth-files/${target.item.id}`, {
        method: 'DELETE', headers: { 'idempotency-key': clientRandomUUID() }
      })
      await refreshCpa()
      syncCpaManager(openIds)
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
    if (target.kind === 'cpa') cpaManagerError.value = failure(value, '删除 CPA 认证文件失败')
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
        <button class="button button--secondary" type="button" @click="openExport"><IconDownload :size="17" />安全导出</button>
        <button class="button button--primary" type="button" @click="openCreate"><IconPlus :size="17" />新增账号</button>
      </div>
    </header>

    <div class="admin-page-tabs" role="tablist" aria-label="账号管理视图">
      <button type="button" role="tab" :aria-selected="activeTab === 'accounts'" :class="{ active: activeTab === 'accounts' }" @click="activeTab = 'accounts'; search = ''"><IconAddressBook :size="17" />账号管理</button>
      <button type="button" role="tab" :aria-selected="activeTab === 'receivers'" :class="{ active: activeTab === 'receivers' }" @click="activeTab = 'receivers'; search = ''"><IconDeviceMobile :size="17" />接码管理</button>
    </div>

    <section class="admin-toolbar account-toolbar">
      <label class="admin-search"><IconSearch :size="17" /><input v-model="search" type="search" :placeholder="activeTab === 'accounts' ? '搜索邮箱、手机号、平台或分组' : '搜索手机号、账号或备注'"></label>
      <span v-if="activeTab === 'accounts'">{{ filteredRows.length }} / {{ unifiedRows.length }} 个账号</span>
      <span v-else>{{ receiverSummary.total }} 个号码 · {{ receiverSummary.available }} 个空余名额</span>
      <button class="icon-button" type="button" title="刷新全部数据" aria-label="刷新全部数据" :disabled="loadingAll" @click="refreshAllData()"><IconRefresh :size="17" :class="{ 'is-spinning': loadingAll }" /></button>
      <button v-if="activeTab === 'receivers'" class="button button--primary button--small" type="button" @click="openReceiverCreate"><IconPlus :size="16" />新增接码</button>
    </section>

    <section v-if="activeTab === 'accounts'" class="admin-table-wrap account-workspace-table-wrap">
      <table class="admin-table account-workspace-table">
        <thead><tr><th>账号</th><th>号池 / 凭据 / 状态</th><th>容量 / 调度</th><th>用量窗口</th><th>短信接码</th><th aria-label="操作" /></tr></thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="row.key">
            <td>
              <div class="account-identity">
                <div v-if="belongsToSub(row) || row.cpaFiles.length || accountPlan(row)" class="account-badge-row">
                  <span v-if="belongsToSub(row)" class="record-badge" data-tone="sub">SUB</span>
                  <span v-if="row.cpaFiles.length" class="record-badge" data-tone="cpa">CPA</span>
                  <span v-if="accountPlan(row)" class="record-badge" data-tone="plan">{{ accountPlan(row) }}</span>
                </div>
                <div class="account-email-row">
                  <a v-if="row.vault?.hasEmailCodeUrl" class="account-email-link" :href="`/api/admin/account-vault/${row.vault.id}/email-link`" target="_blank" rel="noopener noreferrer" :title="`打开 ${row.vault.email} 的邮箱接码页面`"><IconExternalLink :size="13" /><span>{{ row.vault.email }}</span></a>
                  <code v-else class="account-email" :title="accountEmail(row)">{{ accountEmail(row) }}</code>
                </div>
                <button v-if="row.vault && accountPasswords[row.vault.id]" class="password-copy" type="button" :title="`复制密码 ${accountPasswords[row.vault.id]}`" @click="copyText(accountPasswords[row.vault.id]!, '账号密码已复制')"><IconCopy :size="13" /><span>{{ accountPasswords[row.vault.id] }}</span></button>
              </div>
            </td>
            <td>
              <div class="pool-status">
                <template v-if="row.sub">
                  <span class="status-dot" :data-status="subStatusTone(row)"><i />{{ subStatusLabel(row) }}</span>
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
                <small v-if="row.sub?.errorMessage" class="table-sub account-error" :title="row.sub.errorMessage">{{ row.sub.errorMessage }}</small>
              </div>
            </td>
            <td>
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
            <td>
              <div v-if="row.quota?.windows.length" class="quota-windows">
                <div v-for="windowItem in row.quota.windows" :key="windowItem.id">
                  <span><b>{{ windowItem.label }}</b><em>{{ windowItem.remainingPercent !== null ? `${formatQuotaValue(windowItem.remainingPercent)}% 剩余` : `${formatQuotaValue(windowItem.used)} / ${formatQuotaValue(windowItem.limit)}` }}</em></span>
                  <i><b :style="{ width: `${Math.max(0, Math.min(100, windowItem.remainingPercent ?? (windowItem.usedPercent === null ? 0 : 100 - windowItem.usedPercent)))}%` }" /></i>
                  <small v-if="windowItem.resetAt">{{ time(windowItem.resetAt) }} 重置</small>
                </div>
              </div>
              <span v-else-if="row.quota" class="table-muted">{{ row.quota.error || '暂无用量窗口' }}</span>
              <span v-else class="table-muted">—</span>
            </td>
            <td>
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
            <td>
              <div class="table-actions account-row-actions">
                <button v-if="row.vault && !row.sub" class="account-action-button" type="button" title="Auth 登录并接入 Codex" @click="openOAuth(row.vault)"><IconLogin2 :size="14" />授权</button>
                <button v-if="row.cpaFiles.length" class="account-action-button" type="button" title="管理 CPA 认证文件" @click="openCpaManager(row.cpaFiles)"><IconFileCode :size="14" />CPA</button>
                <button v-if="row.sub" class="account-action-button" type="button" title="主动验活" :disabled="subMutating[row.sub.id]" @click="verifySub(row.sub)"><IconCircleCheck :size="14" />验活</button>
                <button v-if="row.sub" class="account-action-button" type="button" title="检测账号状态并刷新用量窗口" :disabled="quotaRefreshing[row.sub.id]" @click="refreshQuota(row.sub)"><IconRefresh :size="14" :class="{ 'is-spinning': quotaRefreshing[row.sub.id] }" />刷新</button>
                <button v-if="row.sub" class="account-action-button" type="button" title="编辑 Sub2API 配置" @click="openSubEdit(row.sub)"><IconEdit :size="14" />编辑</button>
                <button v-if="row.vault" class="account-action-button" type="button" title="编辑账号资料" @click="openEdit(row.vault)"><IconAddressBook :size="14" />资料</button>
                <button v-if="row.vault" class="account-action-button account-action-button--danger" type="button" title="删除本地账号" @click="deleting = { kind: 'vault', item: row.vault }"><IconTrash :size="14" />删除</button>
                <button v-else-if="row.sub" class="account-action-button account-action-button--danger" type="button" title="删除 Sub2API 账号" @click="deleting = { kind: 'sub', item: row.sub }"><IconTrash :size="14" />删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredRows.length"><td colspan="6"><div class="admin-empty account-empty"><IconAddressBook :size="24" /><span>{{ unifiedRows.length ? '没有匹配的账号' : '还没有账号' }}</span><button v-if="!unifiedRows.length" class="button button--primary" type="button" @click="openCreate">新增第一个账号</button></div></td></tr>
        </tbody>
      </table>
    </section>

    <template v-else>
      <section class="admin-table-wrap receiver-table-wrap receiver-table-wrap--page">
        <table class="admin-table receiver-table">
          <thead><tr><th>接码手机号</th><th>绑定数量</th><th>状态</th><th>最新验证码</th><th>最近刷新</th><th aria-label="操作" /></tr></thead>
          <tbody>
            <tr v-for="receiver in filteredReceivers" :key="receiver.id">
              <td><button class="phone-copy" type="button" :title="`复制 ${receiver.copyValue}`" @click="copyText(receiver.copyValue, '手机号已复制（不含 +1）')"><IconCopy :size="13" />{{ receiver.phone }}</button><small class="table-sub">{{ receiver.providerHost }}<template v-if="receiver.note"> · {{ receiver.note }}</template></small></td>
              <td><div class="receiver-count"><IconUsers :size="15" /><strong class="tabular-nums">{{ receiver.bindingCount }}/3</strong><small>{{ receiver.availableSlots }} 个空余名额</small></div></td>
              <td><label class="compact-switch" :class="{ disabled: receiverMutating[receiver.id] }"><input type="checkbox" :checked="receiver.status === 'active'" :disabled="receiverMutating[receiver.id]" @change="toggleReceiver(receiver, ($event.target as HTMLInputElement).checked)"><span aria-hidden="true" /><em>{{ receiver.status === 'active' ? '可用' : '停用' }}</em></label></td>
              <td><div class="receiver-code receiver-code--table"><code v-if="smsCodes[receiver.id]?.code">{{ smsCodes[receiver.id]?.code }}</code><span v-else-if="smsCodes[receiver.id]" :title="smsCodes[receiver.id]?.message">{{ smsMessageSummary(smsCodes[receiver.id]!) }}</span><span v-else>未获取</span><button v-if="smsCodes[receiver.id]?.code" class="icon-button" type="button" title="复制验证码" aria-label="复制验证码" @click="copyText(smsCodes[receiver.id]!.code!, '验证码已复制')"><IconCopy :size="14" /></button></div></td>
              <td><strong>{{ time(receiver.lastFetchedAt) }}</strong><small v-if="receiver.lastFetchStatus === 'error'" class="table-sub receiver-fetch-error">{{ receiver.lastFetchError || '刷新失败' }}</small><small v-else class="table-sub">{{ receiver.lastFetchStatus === 'code_received' ? '已获取验证码' : receiver.lastFetchStatus === 'no_code' ? '暂无新验证码' : '—' }}</small></td>
              <td><div class="table-actions"><button class="icon-button" type="button" title="刷新验证码" aria-label="刷新验证码" :disabled="receiver.status !== 'active' || refreshingCodes[receiver.id]" @click="refreshSmsCode(receiver.id)"><IconRefresh :size="16" :class="{ 'is-spinning': refreshingCodes[receiver.id] }" /></button><button class="icon-button" type="button" title="编辑接码" aria-label="编辑接码" @click="openReceiverEdit(receiver)"><IconEdit :size="16" /></button><button class="icon-button danger" type="button" title="删除接码" aria-label="删除接码" :disabled="receiver.bindingCount > 0 || receiverMutating[receiver.id]" @click="deleting = { kind: 'receiver', item: receiver }"><IconTrash :size="16" /></button></div></td>
            </tr>
            <tr v-if="!filteredReceivers.length"><td colspan="6"><div class="admin-empty account-empty"><IconDeviceMobile :size="24" /><span>{{ receiverData?.items.length ? '没有匹配的接码资源' : '暂无接码资源' }}</span><button v-if="!receiverData?.items.length" class="button button--primary" type="button" @click="openReceiverCreate">新增第一个接码</button></div></td></tr>
          </tbody>
        </table>
      </section>
    </template>

    <div v-if="managingCpaFiles" class="admin-modal-backdrop" @click.self="managingCpaFiles = null">
      <section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true" aria-label="管理 CPA 认证文件">
        <header><div><span>CPA AUTH FILES</span><h2 class="text-balance">CPA 认证文件</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="managingCpaFiles = null"><IconX :size="18" /></button></header>
        <div class="cpa-file-manager">
          <div class="cpa-file-list">
            <div v-for="item in managingCpaFiles" :key="item.id">
              <span><strong>{{ item.name }}</strong><small>{{ item.account || '未提供账号标识' }} · {{ item.provider }} / {{ item.planType || '未知套餐' }}</small></span>
              <span class="status-dot" :data-status="item.disabled ? 'disabled' : statusTone(item.status)"><i />{{ item.disabled ? '已停用' : localizedStatus(item.status) }}</span>
              <time>{{ time(item.lastRefreshAt) }}</time>
              <div class="table-actions">
                <button class="icon-button" type="button" title="验证能力" aria-label="验证 CPA 认证能力" :disabled="cpaMutating[item.id]" @click="verifyCpa(item)"><IconShieldCheck :size="16" /></button>
                <button class="icon-button" type="button" :title="item.disabled ? '启用' : '停用'" :aria-label="item.disabled ? '启用 CPA 认证' : '停用 CPA 认证'" :disabled="cpaMutating[item.id]" @click="toggleCpa(item)"><component :is="item.disabled ? IconPlayerPlay : IconPlayerPause" :size="16" /></button>
                <button class="icon-button danger" type="button" title="永久删除" aria-label="删除 CPA 认证" :disabled="cpaMutating[item.id]" @click="deleting = { kind: 'cpa', item }"><IconTrash :size="16" /></button>
              </div>
            </div>
          </div>
          <p v-if="cpaManagerError" class="form-error">{{ cpaManagerError }}</p>
          <footer><span>{{ managingCpaFiles.length }} 个认证文件</span><button class="button button--secondary" type="button" @click="managingCpaFiles = null">关闭</button></footer>
        </div>
      </section>
    </div>

    <div v-if="showReceiverForm" class="admin-modal-backdrop" @click.self="closeReceiverForm">
      <section class="admin-modal admin-modal--wide receiver-editor-modal" role="dialog" aria-modal="true" :aria-label="editingReceiver ? '编辑接码' : '新增接码'">
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
                  <span><strong>{{ account.displayName || account.email }}</strong><small>#{{ account.slot }} · {{ account.email }}{{ account.deleted ? ' · 已删除账号' : '' }}</small></span>
                  <button class="icon-button danger" type="button" title="解除账号绑定" aria-label="解除账号绑定" :disabled="bindingMutating[account.bindingId]" @click="deleting = { kind: 'binding', receiver: editingReceiver!, account }"><IconTrash :size="15" /></button>
                </div>
              </div>
              <div v-else class="receiver-bindings__empty"><IconUsers :size="19" /><span>尚未绑定账号</span></div>
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

    <div v-if="showForm" class="admin-modal-backdrop" @click.self="closeForm">
      <section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true" :aria-label="editing ? '编辑账号' : '新增账号'">
        <header><div><span>ACCOUNT RECORD</span><h2 class="text-balance">{{ editing ? '编辑账号' : '新增账号' }}</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="saving || deliveryImporting || importSaving || cpaUploadSaving || conversionSaving" @click="closeForm"><IconX :size="18" /></button></header>
        <div v-if="!editing" class="admin-page-tabs vault-create-modes" role="tablist" aria-label="新增方式">
          <button type="button" role="tab" :aria-selected="createMode === 'manual'" :class="{ active: createMode === 'manual' }" @click="createMode = 'manual'; formError = ''; deliveryError = ''">手动新增</button>
          <button type="button" role="tab" :aria-selected="createMode === 'delivery'" :class="{ active: createMode === 'delivery' }" @click="createMode = 'delivery'; formError = ''; deliveryError = ''">发货文本</button>
        </div>
        <div v-if="!editing && createMode === 'manual'" class="admin-page-tabs admin-page-tabs--embedded vault-manual-create-modes" role="tablist" aria-label="手动新增方式">
          <button type="button" role="tab" :aria-selected="manualCreateMode === 'form'" :class="{ active: manualCreateMode === 'form' }" @click="manualCreateMode = 'form'; formError = ''">表单新增</button>
          <button type="button" role="tab" :aria-selected="manualCreateMode === 'upload'" :class="{ active: manualCreateMode === 'upload' }" @click="manualCreateMode = 'upload'; importError = ''; cpaUploadError = ''">上传新增</button>
          <button type="button" role="tab" :aria-selected="manualCreateMode === 'convert'" :class="{ active: manualCreateMode === 'convert' }" @click="manualCreateMode = 'convert'; conversionError = ''">凭据转换</button>
        </div>
        <form v-if="editing || (createMode === 'manual' && manualCreateMode === 'form')" class="admin-form" @submit.prevent="saveVault">
          <div class="form-grid"><label><span>邮箱 *</span><input v-model="form.email" type="email" required autocomplete="off"></label><label><span>姓名</span><input v-model="form.displayName" maxlength="120"></label></div>
          <div class="form-grid"><label><span>账号状态</span><AppSelect v-model="form.status"><option v-for="status in ACCOUNT_VAULT_STATUSES" :key="status" :value="status">{{ status }}</option></AppSelect></label><label><span>{{ editing ? '新密码（留空不修改）' : '账号密码' }}</span><input v-model="form.password" type="password" :required="!editing && !form.emailCodeUrl" maxlength="2000" autocomplete="new-password"></label></div>
          <div class="form-grid"><label><span>邮箱验证码链接{{ editing && editing.hasEmailCodeUrl ? '（已保存；填写新链接可替换）' : '' }}</span><input v-model="form.emailCodeUrl" type="url" maxlength="4000" placeholder="https://" @input="emailCodeUrlTouched = true"></label><label><span>2FA 密钥{{ editing && editing.hasTotpSecret ? '（已保存；填写新密钥可替换）' : '' }}</span><input v-model="form.totpSecret" type="password" maxlength="512" autocomplete="off" placeholder="Base32" @input="totpSecretTouched = true"></label></div>
          <label><span>接码手机号</span><AppSelect v-model="form.smsReceiverId"><option value="">自动分配可用手机号</option><option v-for="receiver in receiverOptions" :key="receiver.id" :value="receiver.id">{{ receiver.phone }} · {{ receiver.bindingCount }}/3</option></AppSelect><small>没有可用号码时账号仍会创建，可在接码管理新增号码后再编辑绑定。</small></label>
          <label><span>备注</span><textarea v-model="form.remark" maxlength="2000" rows="3" /></label>
          <p v-if="formError" class="form-error">{{ formError }}</p>
          <footer><button class="button button--secondary" type="button" @click="closeForm">取消</button><button class="button button--primary" :disabled="saving">{{ saving ? '保存中' : '保存账号' }}</button></footer>
        </form>
        <form v-else-if="createMode === 'manual' && manualCreateMode === 'upload'" class="admin-form vault-upload-form" @submit.prevent="uploadSelectedPool">
          <label><span>号池平台 *</span><AppSelect v-model="uploadPool" :disabled="importSaving || cpaUploadSaving"><option value="sub2api">Sub2API</option><option value="cpa">CPA</option></AppSelect><small>{{ uploadPool === 'sub2api' ? '导入 Sub2API 导出的账号 JSON，可先解析并确认账号列表。' : '上传 CPA 认证 JSON，每批最多 20 个文件。' }}</small></label>
          <template v-if="uploadPool === 'sub2api'">
            <div class="credential-import-head"><label class="button button--secondary"><IconFileCode :size="16" />选择 JSON 文件<input type="file" accept="application/json,.json" @change="readImportFile"></label><span>{{ importFileName || '也可以直接粘贴 JSON 内容' }}</span></div>
            <label><span>JSON 内容 *</span><textarea v-model="importText" rows="8" required spellcheck="false" autocomplete="off" placeholder="{ }" @input="importRows = []" /></label>
            <button type="button" class="button button--secondary button--small import-parse-button" @click="parseImportText(importText)">解析内容</button>
            <div v-if="importRows.length" class="sub-import-preview"><div v-for="row in importRows.slice(0, 20)" :key="row.key"><span><strong>{{ row.name }}</strong><small>{{ row.email || '未识别邮箱' }}</small></span><code>{{ row.platform }} / {{ row.type }}</code></div><small v-if="importRows.length > 20">另有 {{ importRows.length - 20 }} 个账号</small></div>
            <div class="form-grid"><label class="switch"><input v-model="importSchedulable" type="checkbox"><span />导入后立即调度</label><label class="switch"><input v-model="importAdvancedRaw" type="checkbox"><span />允许高级原始凭据</label></div>
            <p v-if="importError" class="form-error vault-delivery-error">{{ importError }}</p>
          </template>
          <template v-else>
            <label class="credential-drop"><IconFileCode :size="25" /><span>选择认证文件（每个最大 2 MiB，最多 20 个）</span><input type="file" multiple accept="application/json,.json" required @change="selectCpaFiles"><small>{{ cpaUploadFiles.length ? `已选择 ${cpaUploadFiles.length} 个文件` : '认证内容只转发给 CPA，不保存到 Hub' }}</small></label>
            <p v-if="cpaUploadError" class="form-error vault-delivery-error">{{ cpaUploadError }}</p>
          </template>
          <footer><span>{{ uploadPool === 'sub2api' ? `${importRows.length} 个账号` : `${cpaUploadFiles.length} 个文件` }}</span><button class="button button--secondary" type="button" :disabled="importSaving || cpaUploadSaving" @click="closeForm">取消</button><button class="button button--primary" :disabled="uploadPool === 'sub2api' ? importSaving || !importRows.length : cpaUploadSaving || !cpaUploadFiles.length"><IconCloudUpload :size="16" />{{ uploadPool === 'sub2api' ? (importSaving ? '导入中' : '导入 Sub2API') : (cpaUploadSaving ? '上传中' : '上传到 CPA') }}</button></footer>
        </form>
        <form v-else-if="createMode === 'manual'" class="admin-form credential-converter-form" @submit.prevent="importConvertedCredentials">
          <div v-show="!conversionRows.length" class="credential-converter-source">
            <label class="credential-drop credential-converter-drop"><IconFileCode :size="25" /><span>选择 ChatGPT Session 或认证 JSON</span><input type="file" multiple accept="application/json,.json" @change="readConversionFiles"><small>最多 20 个文件，单个文件最大 2 MiB</small></label>
            <label><span>粘贴凭据 JSON</span><textarea v-model="conversionInput" rows="7" spellcheck="false" autocomplete="off" placeholder="{ }" /></label>
            <button type="button" class="button button--secondary button--small import-parse-button" :disabled="!conversionInput.trim()" @click="parseConversionInput"><IconFileCode :size="16" />解析凭据</button>
          </div>
          <template v-if="conversionRows.length">
            <div class="conversion-summary"><span><strong class="tabular-nums">{{ conversionRows.length }}</strong><small>已识别账号</small></span><span><strong class="tabular-nums">{{ conversionFileCount }}</strong><small>来源文件</small></span><span><strong class="tabular-nums">{{ conversionSkipped.length }}</strong><small>跳过项目</small></span><button class="button button--quiet button--small" type="button" :disabled="conversionSaving" @click="resetConversionForm">重新选择</button></div>
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
            <section v-if="conversionSub2ApiCount" class="conversion-settings" aria-labelledby="conversion-sub-settings">
              <header><h3 id="conversion-sub-settings">Sub2API 导入设置</h3><span>{{ conversionSub2ApiCount }} 个待导入账号</span></header>
              <div class="form-grid form-grid--four"><label><span>并发</span><input v-model.number="conversionConfig.concurrency" type="number" min="1" max="10000" required></label><label><span>优先级</span><input v-model.number="conversionConfig.priority" type="number" min="0" max="1000000" required></label><label><span>倍率</span><input v-model.number="conversionConfig.rateMultiplier" type="number" min="0" max="1000" step="0.01" required></label><label><span>账号代理</span><AppSelect v-model="conversionConfig.proxyId"><option :value="null">不使用代理（直连）</option><option v-for="proxy in activeProxies()" :key="proxy.id" :value="proxy.id">{{ proxy.name }} · {{ proxy.protocol }}://{{ proxy.host }}:{{ proxy.port }}</option></AppSelect></label></div>
              <fieldset class="group-picker"><legend>所属分组</legend><label v-for="group in groups" :key="group.id"><input v-model="conversionConfig.groupIds" type="checkbox" :value="group.id"><span>{{ group.name }}<small>{{ group.platform }}</small></span></label></fieldset>
              <label class="switch"><input v-model="conversionConfig.schedulable" type="checkbox"><span />导入后立即调度</label>
            </section>
          </template>
          <p v-if="conversionSkipped.length && conversionRows.length" class="conversion-skipped">已跳过 {{ conversionSkipped.length }} 项：{{ conversionSkipped.slice(0, 3).map(item => `${item.sourceName} ${item.message}`).join('；') }}</p>
          <p v-if="conversionError" class="form-error vault-delivery-error">{{ conversionError }}</p>
          <footer><span>{{ selectedConversionRows.length }} 个账号 · CPA {{ conversionCpaCount }} · Sub2API {{ conversionSub2ApiCount }}</span><button class="button button--secondary" type="button" :disabled="conversionSaving" @click="closeForm">取消</button><button v-if="conversionRows.length" class="button button--primary" :disabled="conversionSaving || !selectedConversionRows.length || (!conversionCpaCount && !conversionSub2ApiCount)"><IconCloudUpload :size="16" />{{ conversionSaving ? '导入中' : '转换并导入' }}</button></footer>
        </form>
        <form v-else class="admin-form vault-delivery-form" @submit.prevent="importDelivery">
          <label><span>发货格式 *</span><AppSelect v-model="deliveryFormat" :disabled="deliveryImporting" @change="deliveryError = ''"><option value="" disabled>请选择发货格式</option><option value="email_code_url">邮箱 + 邮箱验证码链接</option><option value="tokens">邮箱 + 密码 + AT + RT</option><option value="password_totp">邮箱 + 密码 + 2FA 密钥</option></AppSelect></label>
          <label><span>发货内容 *</span><textarea v-model="deliveryText" class="vault-delivery-input" required rows="8" autocomplete="off" spellcheck="false" :placeholder="selectedDeliveryFormat?.placeholder || '请先选择上方发货格式'" /></label>
          <div v-if="deliveryPreview.length" class="vault-delivery-preview"><div v-for="item in deliveryPreview.slice(0, 50)" :key="item.index" :data-valid="item.valid"><code>{{ item.email }}</code><span>{{ item.kind }}</span></div><small v-if="deliveryPreview.length > 50">另有 {{ deliveryPreview.length - 50 }} 条待导入</small></div>
          <p v-if="deliveryError" class="form-error vault-delivery-error">{{ deliveryError }}</p>
          <footer><span>{{ deliveryPreview.length }} 个账号</span><button class="button button--secondary" type="button" :disabled="deliveryImporting" @click="closeForm">取消</button><button class="button button--primary" :disabled="deliveryImporting || !deliveryFormat || !deliveryPreview.length">{{ deliveryImporting ? '导入中' : '确认导入' }}</button></footer>
        </form>
      </section>
    </div>

    <div v-if="oauthAccount" class="admin-modal-backdrop" @click.self="oauthAccount = null">
      <section class="admin-modal admin-modal--wide oauth-account-modal" role="dialog" aria-modal="true" aria-label="接入 Codex">
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

    <div v-if="editingSub" class="admin-modal-backdrop" @click.self="editingSub = null">
      <section class="admin-modal admin-modal--wide" role="dialog" aria-modal="true" aria-label="编辑 Sub2API 账号">
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

    <div v-if="showExport" class="admin-modal-backdrop" @click.self="showExport = false">
      <section class="admin-modal vault-security-modal" role="dialog" aria-modal="true" aria-label="导出完整账号">
        <header><div><span>SECURITY CHECK</span><h2 class="text-balance">导出完整账号</h2></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showExport = false"><IconX :size="18" /></button></header>
        <form class="admin-form" @submit.prevent="exportAccounts"><div class="vault-security-note"><IconLock :size="18" /><p class="text-pretty">导出文件包含账号密码、Token、2FA 密钥、邮箱验证码链接和完整接码链接。操作会写入审计日志。</p></div><label><span>当前管理员密码</span><input v-model="exportPassword" type="password" required autocomplete="current-password"></label><p v-if="exportError" class="form-error">{{ exportError }}</p><footer><button class="button button--secondary" type="button" @click="showExport = false">取消</button><button class="button button--primary">确认导出</button></footer></form>
      </section>
    </div>

    <AppConfirmDialog :open="Boolean(deleting)" title="确认删除" :message="deleteMessage(deleting)" :busy="deletingBusy" @close="deleting = null" @confirm="confirmDelete" />
  </div>
</template>

<style scoped>
.account-toolbar { margin-bottom: 12px; }
.account-toolbar > span { margin-left: auto; color: var(--hub-text-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.account-workspace-table { width: 100%; min-width: 1135px; table-layout: auto; }
.account-workspace-table th:nth-child(1) { min-width: 300px; }
.account-workspace-table th:nth-child(2) { width: 250px; }
.account-workspace-table th:nth-child(3) { width: 145px; }
.account-workspace-table th:nth-child(4) { width: 260px; }
.account-workspace-table th:nth-child(5) { width: 220px; }
.account-workspace-table th:nth-child(6) { width: 175px; }
.account-identity { min-width: max-content; display: grid; justify-items: start; gap: 6px; }
.account-badge-row { display: flex; align-items: center; gap: 5px; min-height: 22px; }
.account-email-row { width: max-content; display: flex; align-items: center; gap: 6px; }
.account-email { margin-top: 0; display: inline; color: var(--hub-text); font-size: 12px; font-weight: 700; white-space: nowrap; }
.account-email-link { display: inline-flex; align-items: center; gap: 5px; color: var(--hub-accent-text); font-family: var(--font-mono); font-size: 12px; font-weight: 700; text-decoration: none; white-space: nowrap; }
.account-email-link svg { flex: 0 0 auto; }
.account-email-link span { white-space: nowrap; }
.account-email-link:hover { text-decoration: underline; }
.password-copy { max-width: 100%; padding: 0; border: 0; display: inline-flex; align-items: center; gap: 5px; overflow: hidden; color: var(--hub-accent-text); background: transparent; font-family: var(--font-mono); font-size: 12px; font-weight: 700; cursor: pointer; }
.password-copy svg { flex: 0 0 auto; }
.password-copy span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.password-copy:hover { text-decoration: underline; }
.pool-status { min-width: 0; display: grid; justify-items: start; gap: 6px; }
.local-account-status { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.account-kind-badge { color: var(--hub-text-muted); background: var(--hub-solid-surface-hover); }
.record-badge { min-height: 22px; padding: 2px 7px; border: 1px solid var(--hub-line-strong); border-radius: 4px; display: inline-flex; align-items: center; color: var(--hub-text-muted); background: var(--hub-solid-surface-hover); font-size: 11px; font-weight: 800; white-space: nowrap; }
.record-badge[data-tone='active'] { border-color: var(--hub-success-line); color: var(--hub-success); background: var(--hub-success-soft); }
.record-badge[data-tone='sub'], .record-badge[data-tone='plan'] { border-color: var(--hub-accent-line); color: var(--hub-accent-text); background: var(--hub-accent-soft); }
.record-badge[data-tone='cpa'] { border-color: var(--hub-warning-line); color: var(--hub-warning); background: var(--hub-warning-soft); }
.record-badge[data-tone='error'] { border-color: var(--hub-danger-line); color: var(--hub-danger); background: var(--hub-danger-soft); }
.table-value { display: block; font-variant-numeric: tabular-nums; }
.table-muted { color: var(--hub-text-faint); font-size: 11px; }
.account-error { max-width: 125px; overflow: hidden; color: var(--hub-danger); text-overflow: ellipsis; white-space: nowrap; }
.compact-switch { position: relative; min-width: 105px; margin-top: 6px; display: grid; grid-template-columns: 30px auto; align-items: center; gap: 6px; cursor: pointer; }
.compact-switch input { position: absolute; left: 0; top: 0; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.compact-switch > span { width: 30px; height: 17px; padding: 2px; border: 1px solid var(--hub-line-strong); border-radius: 10px; background: var(--hub-skeleton-strong); }
.compact-switch > span::after { content: ''; display: block; width: 11px; height: 11px; border-radius: 50%; background: var(--hub-solid-surface); box-shadow: 0 1px 2px rgb(0 0 0 / 20%); }
.compact-switch input:checked + span { border-color: var(--hub-accent); background: var(--hub-accent); }
.compact-switch input:checked + span::after { transform: translateX(13px); }
.compact-switch em { color: var(--hub-text-muted); font-size: 11px; font-style: normal; font-weight: 700; white-space: nowrap; }
.compact-switch.disabled { cursor: wait; opacity: .55; }
.quota-windows { display: grid; gap: 7px; }
.quota-windows > div { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 62px; align-items: center; gap: 3px 8px; }
.quota-windows span { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.quota-windows span b { overflow: hidden; color: var(--hub-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.quota-windows span em { color: var(--hub-text-muted); font-size: 11px; font-style: normal; font-variant-numeric: tabular-nums; white-space: nowrap; }
.quota-windows i { height: 4px; border-radius: 2px; grid-column: 1; overflow: hidden; background: var(--hub-skeleton-strong); }
.quota-windows i b { height: 100%; display: block; background: var(--hub-accent); }
.quota-windows small { grid-column: 2; grid-row: 1 / span 2; color: var(--hub-text-faint); font-size: 10px; line-height: 1.35; text-align: right; }
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
.cpa-file-manager { padding: 18px 22px 20px; display: grid; gap: 16px; }
.cpa-file-list { border-block: 1px solid var(--hub-line); }
.cpa-file-list > div { min-height: 64px; padding: 9px 2px; border-bottom: 1px solid var(--hub-line-row); display: grid; grid-template-columns: minmax(0, 1fr) 100px 105px 132px; align-items: center; gap: 12px; }
.cpa-file-list > div:last-child { border-bottom: 0; }
.cpa-file-list > div > span:first-child { min-width: 0; display: grid; gap: 4px; }
.cpa-file-list strong, .cpa-file-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpa-file-list small, .cpa-file-list time { color: var(--hub-text-faint); font-size: 11px; }
.cpa-file-manager > footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.cpa-file-manager > footer > span { margin-right: auto; color: var(--hub-text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.oauth-login-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.credential-import-head { display: flex; align-items: center; gap: 12px; }
.credential-import-head label { position: relative; }
.credential-import-head input { position: absolute; width: 1px; height: 1px; opacity: 0; clip-path: inset(50%); }
.credential-import-head span { overflow: hidden; color: var(--hub-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.import-parse-button { justify-self: start; }
.sub-import-preview { max-height: 220px; border-block: 1px solid var(--hub-line); overflow: auto; }
.sub-import-preview > div { min-height: 48px; padding: 8px 2px; border-bottom: 1px solid var(--hub-line-row); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sub-import-preview > div:last-of-type { border-bottom: 0; }
.sub-import-preview span { min-width: 0; display: grid; gap: 3px; }
.sub-import-preview strong, .sub-import-preview small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-import-preview small { color: var(--hub-text-faint); font-size: 11px; }
.sub-import-preview code { flex: 0 0 auto; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.vault-manual-create-modes { width: min(460px, calc(100% - 40px)); margin: 8px 20px 0; }
.vault-manual-create-modes button { flex: 1; }
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
  .credential-import-head { align-items: stretch; flex-direction: column; }
  .conversion-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .conversion-summary .button { grid-column: 1 / -1; }
  .conversion-list article { grid-template-columns: 24px minmax(0, 1fr); }
  .conversion-flags, .conversion-targets, .conversion-warning { grid-column: 2; }
  .conversion-targets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .credential-converter-form > footer { align-items: stretch; flex-wrap: wrap; }
  .credential-converter-form > footer > span { width: 100%; }
  .credential-converter-form > footer .button { flex: 1; }
  .cpa-file-list > div { grid-template-columns: minmax(0, 1fr) auto; }
  .cpa-file-list > div > time { display: none; }
  .cpa-file-list .table-actions { grid-column: 1 / -1; justify-content: flex-end; }
}
</style>
