import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, gte, ilike, lte, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import {
  ACCOUNT_VAULT_STATUSES,
  LEDGER_TRANSACTION_TYPES,
  WARRANTY_STATUSES,
  type AccountVaultStatus,
  type AccountCredentialKind,
  type AccountVaultView,
  type LedgerSummary,
  type LedgerTransactionType,
  type LedgerTransactionView,
  type WarrantyStatus
} from '#shared/types/accounting'
import { useDatabase, withDatabaseTransaction } from '../db'
import { accountVaultEntries, ledgerTransactions, smsReceiverBindings } from '../db/schema'
import { decryptContextSecret, encryptContextSecret } from '../utils/hub-crypto'
import { zonedDateKey } from '../utils/time-zone'
import {
  accountSmsReceiverMap,
  assignAvailableSmsReceiver,
  assertSmsReceiverAvailable,
  bindAccountSmsReceiver,
  ensureLegacySmsReceiver
} from './sms-receivers'

type UnknownRecord = Record<string, unknown>

const accountStatuses = new Set<string>(ACCOUNT_VAULT_STATUSES)
const warrantyStatuses = new Set<string>(WARRANTY_STATUSES)
const transactionTypes = new Set<string>(LEDGER_TRANSACTION_TYPES)

function text(value: unknown, label: string, maxLength: number, required = false) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (required && !normalized) throw createError({ statusCode: 400, message: `${label}不能为空` })
  if (normalized.length > maxLength) throw createError({ statusCode: 400, message: `${label}不能超过 ${maxLength} 个字符` })
  return normalized
}

function optionalText(value: unknown, label: string, maxLength: number) {
  return text(value, label, maxLength) || null
}

function dateText(value: unknown, label: string) {
  const normalized = text(value, label, 10)
  if (!normalized) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw createError({ statusCode: 400, message: `${label}格式必须为 YYYY-MM-DD` })
  const parsed = new Date(`${normalized}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw createError({ statusCode: 400, message: `${label}无效` })
  }
  return normalized
}

function emailText(value: unknown) {
  const email = text(value, '邮箱', 320, true)
  if (!/^\S+@\S+\.\S+$/.test(email)) throw createError({ statusCode: 400, message: '邮箱格式不正确' })
  return email
}

function enumText<T extends string>(value: unknown, values: Set<string>, fallback: T, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) return fallback
  if (!values.has(normalized)) throw createError({ statusCode: 400, message: `${label}无效` })
  return normalized as T
}

function sourceFingerprint(namespace: string, record: UnknownRecord, index: number) {
  return createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(JSON.stringify(record))
    .update('\0')
    .update(String(index))
    .digest('hex')
}

function accountPassword(value: unknown, required: boolean) {
  const password = typeof value === 'string' ? value : ''
  if (required && !password) throw createError({ statusCode: 400, message: '账号密码不能为空' })
  if (password.length > 2000) throw createError({ statusCode: 400, message: '账号密码不能超过 2000 个字符' })
  return password
}

function accountSecret(value: unknown, label: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.length > maxLength) throw createError({ statusCode: 400, message: `${label}长度超出限制` })
  return normalized
}

function emailCodeUrl(value: unknown) {
  const normalized = accountSecret(value, '邮箱验证码链接', 4000)
  if (!normalized) return ''
  let parsed: URL
  try { parsed = new URL(normalized) } catch { throw createError({ statusCode: 400, message: '邮箱验证码链接格式不正确' }) }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw createError({ statusCode: 400, message: '邮箱验证码链接只支持 HTTP 或 HTTPS' })
  return parsed.toString()
}

function accountContext(id: string, field: 'password' | 'access-token' | 'refresh-token' | 'email-code-url' = 'password') {
  return `account-vault:${id}:${field}`
}

function credentialKind(row: typeof accountVaultEntries.$inferSelect): AccountCredentialKind {
  if (row.encryptedAccessToken || row.encryptedRefreshToken) return 'tokens'
  if (row.encryptedEmailCodeUrl) return 'email_code_url'
  return 'password'
}

function accountView(
  row: typeof accountVaultEntries.$inferSelect,
  receiver: AccountVaultView['smsReceiver'] = null
): AccountVaultView {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status as AccountVaultStatus,
    credentialKind: credentialKind(row),
    hasEmailCodeUrl: Boolean(row.encryptedEmailCodeUrl),
    sub2apiAccountId: row.sub2apiAccountId,
    codexAddedAt: row.codexAddedAt?.getTime() || null,
    maskedPassword: '••••••••',
    purchaseDate: row.purchaseDate,
    warrantyDate: row.warrantyDate,
    warrantyStatus: row.warrantyStatus as WarrantyStatus,
    smsReceiver: receiver,
    remark: row.remark,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

function accountValues(body: UnknownRecord) {
  return {
    email: emailText(body.email),
    displayName: optionalText(body.displayName ?? body.name, '姓名', 120),
    status: enumText(body.status, accountStatuses, 'Codex' as AccountVaultStatus, '账号状态'),
    purchaseDate: dateText(body.purchaseDate ?? body.purchaseTime, '购买日期'),
    warrantyDate: dateText(body.warrantyDate ?? body.warrantyTime, '质保日期'),
    warrantyStatus: enumText(body.warrantyStatus, warrantyStatuses, '有质保' as WarrantyStatus, '质保状态'),
    remark: optionalText(body.remark, '备注', 2000)
  }
}

export async function listAccountVaultEntries(event: H3Event, query: Record<string, string | undefined> = {}) {
  const search = text(query.search, '搜索内容', 200)
  const status = query.status ? enumText(query.status, accountStatuses, 'Codex' as AccountVaultStatus, '账号状态') : null
  const [rows, receivers] = await Promise.all([
    useDatabase(event).select().from(accountVaultEntries)
      .where(status ? eq(accountVaultEntries.status, status) : undefined)
      .orderBy(desc(accountVaultEntries.updatedAt)),
    accountSmsReceiverMap(event)
  ])
  const views = rows.map(row => accountView(row, receivers.get(row.id) || null))
  if (!search) return views
  const needle = search.toLowerCase()
  return views.filter(item => `${item.email} ${item.displayName || ''} ${item.smsReceiver?.phone || ''} ${item.remark || ''}`.toLowerCase().includes(needle))
}

export async function getAccountVaultEntry(event: H3Event, id: string) {
  const item = (await listAccountVaultEntries(event)).find(entry => entry.id === id)
  if (!item) throw createError({ statusCode: 404, message: '账号资料不存在' })
  return item
}

async function accountRow(event: H3Event, id: string) {
  const [row] = await useDatabase(event).select().from(accountVaultEntries).where(eq(accountVaultEntries.id, id)).limit(1)
  if (!row) throw createError({ statusCode: 404, message: '账号资料不存在' })
  return row
}

export async function createAccountVaultEntry(event: H3Event, body: UnknownRecord, actorId: string, sourceRef: string | null = null) {
  return withDatabaseTransaction(event, async () => {
    const id = randomUUID()
    const accessToken = accountSecret(body.accessToken, 'Access Token', 16_000)
    const refreshToken = accountSecret(body.refreshToken, 'Refresh Token', 16_000)
    const codeUrl = emailCodeUrl(body.emailCodeUrl)
    if (Boolean(accessToken) !== Boolean(refreshToken)) throw createError({ statusCode: 400, message: 'Access Token 和 Refresh Token 必须同时提供' })
    if (codeUrl && (accessToken || refreshToken)) throw createError({ statusCode: 400, message: '邮箱验证码链接与 Token 凭据不能同时提供' })
    const password = accountPassword(body.password, !codeUrl)
    const values = {
      ...accountValues(body),
      purchaseDate: zonedDateKey(new Date(), 'Asia/Shanghai'),
      warrantyDate: null,
      warrantyStatus: '无质保'
    }
    let receiverId = typeof body.smsReceiverId === 'string' && body.smsReceiverId ? body.smsReceiverId : null
    if (!receiverId && body.phone && body.smsUrl) receiverId = await ensureLegacySmsReceiver(event, body.phone, body.smsUrl, actorId)
    if (receiverId) await assertSmsReceiverAvailable(event, receiverId)
    const [created] = await useDatabase(event).insert(accountVaultEntries).values({
      id,
      ...values,
      encryptedPassword: encryptContextSecret(password, accountContext(id), event),
      encryptedAccessToken: accessToken ? encryptContextSecret(accessToken, accountContext(id, 'access-token'), event) : null,
      encryptedRefreshToken: refreshToken ? encryptContextSecret(refreshToken, accountContext(id, 'refresh-token'), event) : null,
      encryptedEmailCodeUrl: codeUrl ? encryptContextSecret(codeUrl, accountContext(id, 'email-code-url'), event) : null,
      sourceRef,
      createdBy: actorId,
      updatedBy: actorId
    }).returning()
    if (!created) throw createError({ statusCode: 500, message: '创建账号资料失败' })
    if (receiverId) await bindAccountSmsReceiver(event, id, receiverId, actorId)
    else await assignAvailableSmsReceiver(event, id, actorId)
    return getAccountVaultEntry(event, id)
  })
}

export async function updateAccountVaultEntry(event: H3Event, id: string, body: UnknownRecord, actorId: string) {
  const current = await accountRow(event, id)
  const password = accountPassword(body.password, false)
  const nextEmailCodeUrl = Object.prototype.hasOwnProperty.call(body, 'emailCodeUrl') ? emailCodeUrl(body.emailCodeUrl) : undefined
  const values = accountValues({
    email: body.email ?? current.email,
    displayName: body.displayName === undefined ? current.displayName : body.displayName,
    status: body.status ?? current.status,
    purchaseDate: body.purchaseDate === undefined ? current.purchaseDate : body.purchaseDate,
    warrantyDate: body.warrantyDate === undefined ? current.warrantyDate : body.warrantyDate,
    warrantyStatus: body.warrantyStatus ?? current.warrantyStatus,
    remark: body.remark === undefined ? current.remark : body.remark
  })
  const [updated] = await useDatabase(event).update(accountVaultEntries).set({
    ...values,
    ...(password ? { encryptedPassword: encryptContextSecret(password, accountContext(id), event) } : {}),
    ...(nextEmailCodeUrl !== undefined ? {
      encryptedEmailCodeUrl: nextEmailCodeUrl
        ? encryptContextSecret(nextEmailCodeUrl, accountContext(id, 'email-code-url'), event)
        : null
    } : {}),
    updatedBy: actorId,
    updatedAt: new Date()
  }).where(eq(accountVaultEntries.id, id)).returning()
  if (!updated) throw createError({ statusCode: 500, message: '更新账号资料失败' })
  await useDatabase(event).update(smsReceiverBindings).set({
    accountEmail: updated.email,
    accountDisplayName: updated.displayName
  }).where(eq(smsReceiverBindings.accountId, id))
  if (Object.prototype.hasOwnProperty.call(body, 'smsReceiverId')) {
    const receiverId = typeof body.smsReceiverId === 'string' && body.smsReceiverId ? body.smsReceiverId : null
    await bindAccountSmsReceiver(event, id, receiverId, actorId)
  }
  return getAccountVaultEntry(event, id)
}

export async function revealAccountVaultEmailCodeUrl(event: H3Event, id: string) {
  const row = await accountRow(event, id)
  if (!row.encryptedEmailCodeUrl) throw createError({ statusCode: 404, message: '该账号尚未填写邮箱链接' })
  try {
    return decryptContextSecret(row.encryptedEmailCodeUrl, accountContext(id, 'email-code-url'), event)
  } catch {
    throw createError({ statusCode: 500, message: '邮箱链接密文无法解密，请检查加密密钥配置' })
  }
}

export async function markAccountVaultCodexAdded(event: H3Event, id: string, sub2apiAccountId: string, actorId: string) {
  const current = await accountRow(event, id)
  const [updated] = await useDatabase(event).update(accountVaultEntries).set({
    sub2apiAccountId,
    codexAddedAt: new Date(),
    status: '已登录',
    updatedBy: actorId,
    updatedAt: new Date()
  }).where(eq(accountVaultEntries.id, current.id)).returning()
  if (!updated) throw createError({ statusCode: 500, message: '账号已进入 Sub2API，但本地状态更新失败' })
  return getAccountVaultEntry(event, id)
}

export async function deleteAccountVaultEntry(event: H3Event, id: string) {
  const current = await accountRow(event, id)
  await useDatabase(event).transaction(async (transaction) => {
    await transaction.update(smsReceiverBindings).set({
      accountEmail: current.email,
      accountDisplayName: current.displayName,
      deletedAt: new Date()
    }).where(eq(smsReceiverBindings.accountId, id))
    await transaction.delete(accountVaultEntries).where(eq(accountVaultEntries.id, id))
  })
  return { id: current.id, email: current.email }
}

export async function revealAccountVaultPassword(event: H3Event, id: string) {
  const row = await accountRow(event, id)
  try {
    return { id, password: decryptContextSecret(row.encryptedPassword, accountContext(id), event) }
  } catch {
    throw createError({ statusCode: 500, message: '账号密码密文无法解密，请检查加密密钥配置' })
  }
}

export async function revealAccountVaultCredentials(event: H3Event, id: string) {
  const row = await accountRow(event, id)
  try {
    return {
      password: decryptContextSecret(row.encryptedPassword, accountContext(id), event),
      accessToken: row.encryptedAccessToken ? decryptContextSecret(row.encryptedAccessToken, accountContext(id, 'access-token'), event) : '',
      refreshToken: row.encryptedRefreshToken ? decryptContextSecret(row.encryptedRefreshToken, accountContext(id, 'refresh-token'), event) : '',
      emailCodeUrl: row.encryptedEmailCodeUrl ? decryptContextSecret(row.encryptedEmailCodeUrl, accountContext(id, 'email-code-url'), event) : ''
    }
  } catch {
    throw createError({ statusCode: 500, message: '账号凭据密文无法解密，请检查加密密钥配置' })
  }
}

export interface AccountDeliveryLine {
  index: number
  email: string
  kind: 'email_code_url' | 'tokens' | 'invalid'
  record: UnknownRecord | null
  message: string | null
  fingerprint: string
}

export function parseAccountDeliveryText(value: unknown): AccountDeliveryLine[] {
  if (typeof value !== 'string') throw createError({ statusCode: 400, message: '发货内容必须是文本' })
  if (Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) throw createError({ statusCode: 413, message: '发货内容不能超过 2 MiB' })
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) throw createError({ statusCode: 400, message: '发货内容不能为空' })
  if (lines.length > 1000) throw createError({ statusCode: 400, message: '单次最多导入 1000 个账号' })
  return lines.map((line, index) => {
    const fingerprint = createHash('sha256').update(line).digest('hex')
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) {
      return { index, email: '', kind: 'invalid', record: null, message: '单行内容不能超过 64 KiB', fingerprint }
    }
    const fields = line.split('----').map(field => field.trim())
    const email = fields[0] || ''
    try {
      emailText(email)
      if (fields.length === 2) {
        const codeUrl = emailCodeUrl(fields[1])
        if (!codeUrl) throw createError({ statusCode: 400, message: '邮箱验证码链接不能为空' })
        return { index, email, kind: 'email_code_url', record: { email, password: '', emailCodeUrl: codeUrl }, message: null, fingerprint }
      }
      if (fields.length === 4) {
        const password = accountPassword(fields[1], true)
        const accessToken = accountSecret(fields[2], 'Access Token', 16_000)
        const refreshToken = accountSecret(fields[3], 'Refresh Token', 16_000)
        if (!accessToken || !refreshToken) throw createError({ statusCode: 400, message: 'Access Token 和 Refresh Token 不能为空' })
        return { index, email, kind: 'tokens', record: { email, password, accessToken, refreshToken }, message: null, fingerprint }
      }
      throw createError({ statusCode: 400, message: '仅支持“邮箱----验证码链接”或“邮箱----密码----AT----RT”格式' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '发货格式不正确'
      return { index, email, kind: 'invalid', record: null, message, fingerprint }
    }
  })
}

function safeAccountImportError(error: unknown) {
  const typed = error as { statusCode?: number; message?: string }
  return typed.statusCode && typed.statusCode >= 400 && typed.statusCode < 500 && typed.message
    ? typed.message.replace(/https?:\/\/\S+/g, '[链接]').slice(0, 300)
    : '账号创建失败'
}

export async function importAccountDeliveryText(event: H3Event, value: unknown, actorId: string) {
  const lines = parseAccountDeliveryText(value)
  let created = 0
  let skipped = 0
  const failed: Array<{ index: number; email: string; message: string }> = []
  for (const line of lines) {
    if (!line.record) {
      failed.push({ index: line.index, email: line.email, message: line.message || '发货格式不正确' })
      continue
    }
    const sourceRef = `account-delivery:${line.fingerprint}`
    const [existing] = await useDatabase(event).select({ id: accountVaultEntries.id }).from(accountVaultEntries)
      .where(eq(accountVaultEntries.sourceRef, sourceRef)).limit(1)
    if (existing) {
      skipped++
      continue
    }
    try {
      await createAccountVaultEntry(event, line.record, actorId, sourceRef)
      created++
    } catch (error) {
      failed.push({ index: line.index, email: line.email, message: safeAccountImportError(error) })
    }
  }
  return { created, skipped, failed }
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw createError({ statusCode: 400, message: `${label}必须是 ${minimum} 到 ${maximum} 之间的整数` })
  }
  return number
}

export function yuanToCents(value: unknown) {
  const raw = typeof value === 'number' ? String(value) : text(value, '单价', 40, true)
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw createError({ statusCode: 400, message: '单价必须是最多两位小数的非负金额' })
  const [whole, fraction = ''] = raw.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > 9_000_000_000_000) throw createError({ statusCode: 400, message: '单价超出可用范围' })
  return cents
}

export function normalizeLedgerTransaction(body: UnknownRecord) {
  const type = enumText(body.type, transactionTypes, 'personal_expense' as LedgerTransactionType, '流水类型')
  const occurredOn = dateText(body.occurredOn, '日期')
  if (!occurredOn) throw createError({ statusCode: 400, message: '日期不能为空' })
  const unitPriceCents = body.unitPriceCents === undefined
    ? yuanToCents(body.unitPrice)
    : integer(body.unitPriceCents, '单价（分）', 0, 9_000_000_000_000)
  const quantity = integer(body.quantity, '数量', 1, 100_000)
  const amountCents = unitPriceCents * quantity
  if (!Number.isSafeInteger(amountCents)) throw createError({ statusCode: 400, message: '金额超出可用范围' })
  return {
    occurredOn,
    type,
    project: text(body.project, '项目', 120),
    unitPriceCents,
    quantity,
    amountCents,
    note: text(body.note, '备注', 500)
  }
}

function ledgerView(row: typeof ledgerTransactions.$inferSelect): LedgerTransactionView {
  return {
    id: row.id,
    occurredOn: row.occurredOn,
    type: row.type as LedgerTransactionType,
    project: row.project,
    unitPriceCents: row.unitPriceCents,
    quantity: row.quantity,
    amountCents: row.amountCents,
    note: row.note,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

export function summarizeLedger(records: Array<Pick<LedgerTransactionView, 'type' | 'amountCents'>>): LedgerSummary {
  const summary: LedgerSummary = {
    recordCount: 0,
    totalExpenseCents: 0,
    personalExpenseCents: 0,
    personalIncomeCents: 0,
    linglongExpenseCents: 0,
    nvtokensTopupCents: 0,
    nvtokensConsumptionCents: 0,
    nvtokensBalanceCents: 0,
    netCents: 0
  }
  for (const record of records) {
    const amount = Number(record.amountCents)
    if (!Number.isSafeInteger(amount)) continue
    summary.recordCount++
    if (record.type === 'personal_expense') summary.personalExpenseCents += amount
    if (record.type === 'personal_income') summary.personalIncomeCents += amount
    if (record.type === 'linglong_expense') summary.linglongExpenseCents += amount
    if (record.type === 'nvtokens_topup') summary.nvtokensTopupCents += amount
    if (record.type === 'nvtokens_consumption') summary.nvtokensConsumptionCents += amount
  }
  summary.totalExpenseCents = summary.personalExpenseCents + summary.linglongExpenseCents + summary.nvtokensTopupCents
  summary.nvtokensBalanceCents = summary.nvtokensTopupCents - summary.nvtokensConsumptionCents
  summary.netCents = summary.personalIncomeCents - summary.personalExpenseCents - summary.nvtokensTopupCents
  return summary
}

function ledgerConditions(query: Record<string, string | undefined>) {
  const search = text(query.search, '搜索内容', 200)
  const type = query.type ? enumText(query.type, transactionTypes, 'personal_expense' as LedgerTransactionType, '流水类型') : null
  const from = query.from ? dateText(query.from, '开始日期') : null
  const to = query.to ? dateText(query.to, '结束日期') : null
  if (from && to && from > to) throw createError({ statusCode: 400, message: '日期范围不正确' })
  return and(
    type ? eq(ledgerTransactions.type, type) : undefined,
    from ? gte(ledgerTransactions.occurredOn, from) : undefined,
    to ? lte(ledgerTransactions.occurredOn, to) : undefined,
    search ? or(ilike(ledgerTransactions.project, `%${search}%`), ilike(ledgerTransactions.note, `%${search}%`)) : undefined
  )
}

export async function listLedgerTransactions(event: H3Event, query: Record<string, string | undefined> = {}) {
  const db = useDatabase(event)
  const [filteredRows, allRows] = await Promise.all([
    db.select().from(ledgerTransactions).where(ledgerConditions(query)).orderBy(desc(ledgerTransactions.occurredOn), desc(ledgerTransactions.createdAt)),
    db.select().from(ledgerTransactions)
  ])
  const items = filteredRows.map(ledgerView)
  return { items, summary: summarizeLedger(items), overallSummary: summarizeLedger(allRows.map(ledgerView)) }
}

async function ledgerRow(event: H3Event, id: string) {
  const [row] = await useDatabase(event).select().from(ledgerTransactions).where(eq(ledgerTransactions.id, id)).limit(1)
  if (!row) throw createError({ statusCode: 404, message: '流水记录不存在' })
  return row
}

export async function createLedgerTransaction(event: H3Event, body: UnknownRecord, actorId: string, sourceRef: string | null = null) {
  const [created] = await useDatabase(event).insert(ledgerTransactions).values({
    id: randomUUID(),
    ...normalizeLedgerTransaction(body),
    sourceRef,
    createdBy: actorId,
    updatedBy: actorId
  }).returning()
  if (!created) throw createError({ statusCode: 500, message: '创建流水失败' })
  return ledgerView(created)
}

export async function updateLedgerTransaction(event: H3Event, id: string, body: UnknownRecord, actorId: string) {
  const current = await ledgerRow(event, id)
  const values = normalizeLedgerTransaction({
    occurredOn: body.occurredOn ?? current.occurredOn,
    type: body.type ?? current.type,
    project: body.project === undefined ? current.project : body.project,
    ...(body.unitPrice !== undefined
      ? { unitPrice: body.unitPrice }
      : { unitPriceCents: body.unitPriceCents ?? current.unitPriceCents }),
    quantity: body.quantity ?? current.quantity,
    note: body.note === undefined ? current.note : body.note
  })
  const [updated] = await useDatabase(event).update(ledgerTransactions).set({
    ...values,
    updatedBy: actorId,
    updatedAt: new Date()
  }).where(eq(ledgerTransactions.id, id)).returning()
  if (!updated) throw createError({ statusCode: 500, message: '更新流水失败' })
  return ledgerView(updated)
}

export async function deleteLedgerTransaction(event: H3Event, id: string) {
  const current = await ledgerRow(event, id)
  await useDatabase(event).delete(ledgerTransactions).where(eq(ledgerTransactions.id, id))
  return ledgerView(current)
}

export async function importLedgerTransactions(event: H3Event, records: unknown, actorId: string, source = 'legacy-sqlite') {
  if (!Array.isArray(records)) throw createError({ statusCode: 400, message: '导入内容必须是流水数组' })
  if (records.length > 10_000) throw createError({ statusCode: 400, message: '单次最多导入 10000 条流水' })
  let created = 0
  let skipped = 0
  const failed: Array<{ index: number; message: string }> = []
  for (const [index, value] of records.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      failed.push({ index, message: '流水格式不正确' })
      continue
    }
    const record = value as UnknownRecord
    const sourceRef = sourceFingerprint(`ledger-import:${text(source, '来源', 80) || 'json'}`, record, index)
    const [existing] = await useDatabase(event).select({ id: ledgerTransactions.id }).from(ledgerTransactions)
      .where(eq(ledgerTransactions.sourceRef, sourceRef)).limit(1)
    if (existing) {
      skipped++
      continue
    }
    try {
      await createLedgerTransaction(event, record, actorId, sourceRef)
      created++
    } catch (error) {
      failed.push({ index, message: error instanceof Error ? error.message : '导入失败' })
    }
  }
  return { created, skipped, failed }
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export async function exportLedgerCsv(event: H3Event, query: Record<string, string | undefined>) {
  const { items } = await listLedgerTransactions(event, query)
  const labels: Record<LedgerTransactionType, string> = {
    personal_expense: '我的支出',
    personal_income: '我的收入',
    linglong_expense: '灵龙支出',
    nvtokens_topup: 'nvtokens 储值',
    nvtokens_consumption: '消费储值'
  }
  const rows = [
    ['日期', '类型', '项目', '单价', '数量', '金额', '备注'],
    ...items.map(item => [
      item.occurredOn,
      labels[item.type],
      item.project,
      (item.unitPriceCents / 100).toFixed(2),
      item.quantity,
      (item.amountCents / 100).toFixed(2),
      item.note
    ])
  ]
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`
}
