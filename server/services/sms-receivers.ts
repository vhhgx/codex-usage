import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { AccountSmsReceiverView, SmsCodeResult, SmsReceiverImportResult, SmsReceiverView } from '#shared/types/accounting'
import { useDatabase } from '../db'
import { accountVaultEntries, smsReceiverBindings, smsReceivers } from '../db/schema'
import { decryptContextSecret, encryptContextSecret } from '../utils/hub-crypto'

type UnknownRecord = Record<string, unknown>

export const MAX_SMS_RECEIVER_BINDINGS = 3
const MAX_RESPONSE_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 12_000
const MAX_IMPORT_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_LINES = 1_000
const MAX_IMPORT_LINE_BYTES = 4 * 1024

function text(value: unknown, label: string, maxLength: number, required = false) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (required && !normalized) throw createError({ statusCode: 400, message: `${label}不能为空` })
  if (normalized.length > maxLength) throw createError({ statusCode: 400, message: `${label}不能超过 ${maxLength} 个字符` })
  return normalized
}

function receiverStatus(value: unknown, fallback: 'active' | 'disabled' = 'active') {
  if (value === undefined || value === null || value === '') return fallback
  if (value !== 'active' && value !== 'disabled') throw createError({ statusCode: 400, message: '接码状态无效' })
  return value
}

export function normalizeSmsPhone(value: unknown) {
  const raw = text(value, '接码手机号', 40, true)
  if (!/^\+?[\d\s()-]+$/.test(raw)) throw createError({ statusCode: 400, message: '接码手机号格式不正确' })
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 15) throw createError({ statusCode: 400, message: '接码手机号必须包含 6 到 15 位数字' })
  const usNumber = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null
  return {
    phone: usNumber ? `+1(${usNumber.slice(0, 3)})${usNumber.slice(3)}` : raw,
    phoneKey: usNumber ? `1${usNumber}` : digits,
    copyValue: usNumber || digits
  }
}

export function smsPhonePresentation(value: string) {
  const digits = value.replace(/\D/g, '')
  const usNumber = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null
  return {
    phone: usNumber ? `+1(${usNumber.slice(0, 3)})${usNumber.slice(3)}` : value,
    copyValue: usNumber || digits
  }
}

export function isSmsReceiverReadyForDeletion(
  bindings: Array<{ accountId: string | null; deletedAt: Date | null }>
) {
  return bindings.length === MAX_SMS_RECEIVER_BINDINGS
    && bindings.every(binding => Boolean(binding.deletedAt))
}

function smsContext(id: string) {
  return `sms-receiver:${id}:fetch-url`
}

function parsedFetchUrl(value: unknown) {
  const raw = text(value, '接码接口 URL', 3000, true)
  let url: URL
  try { url = new URL(raw) } catch { throw createError({ statusCode: 400, message: '接码接口 URL 格式不正确' }) }
  if (!['http:', 'https:'].includes(url.protocol)) throw createError({ statusCode: 400, message: '接码接口只支持 HTTP 或 HTTPS' })
  if (url.username || url.password) throw createError({ statusCode: 400, message: '接码接口 URL 不能包含 Basic Auth 凭据' })
  url.hash = ''
  return url
}

interface SmsReceiverImportCandidate {
  line: number
  phone: string
  phoneKey: string
  url: URL
}

function serviceErrorMessage(error: unknown, fallback: string) {
  const typed = error as { data?: { message?: string }; statusMessage?: string; message?: string }
  return typed.data?.message || typed.statusMessage || typed.message || fallback
}

export function parseSmsReceiverImportText(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createError({ statusCode: 400, message: '接码发货文本不能为空' })
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_IMPORT_BYTES) {
    throw createError({ statusCode: 413, message: '接码发货文本不能超过 2 MiB' })
  }
  const lines = value.split(/\r?\n/)
  if (lines.length > MAX_IMPORT_LINES) {
    throw createError({ statusCode: 400, message: `单次最多导入 ${MAX_IMPORT_LINES} 行接码资源` })
  }

  const candidates: SmsReceiverImportCandidate[] = []
  const failed: SmsReceiverImportResult['failed'] = []
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line) return
    const lineNumber = index + 1
    if (Buffer.byteLength(line, 'utf8') > MAX_IMPORT_LINE_BYTES) {
      failed.push({ line: lineNumber, phone: null, error: '单行内容不能超过 4 KiB' })
      return
    }
    const separator = line.indexOf('|')
    const phoneValue = separator >= 0 ? line.slice(0, separator).trim() : ''
    const urlValue = separator >= 0 ? line.slice(separator + 1).trim() : ''
    if (!phoneValue || !urlValue) {
      failed.push({ line: lineNumber, phone: phoneValue || null, error: '格式应为“手机号|接码接口 URL”' })
      return
    }
    try {
      const { phone, phoneKey } = normalizeSmsPhone(phoneValue)
      candidates.push({ line: lineNumber, phone, phoneKey, url: parsedFetchUrl(urlValue) })
    } catch (error) {
      failed.push({ line: lineNumber, phone: phoneValue, error: serviceErrorMessage(error, '接码内容格式不正确') })
    }
  })

  if (!candidates.length && !failed.length) {
    throw createError({ statusCode: 400, message: '接码发货文本没有可导入的内容' })
  }
  return { candidates, failed }
}

function privateIpv4(address: string) {
  const bytes = address.split('.').map(Number)
  const [a = 0, b = 0, c = 0] = bytes
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 192 && b === 0 ||
    a === 198 && (b === 18 || b === 19) ||
    a === 198 && b === 51 && c === 100 ||
    a === 203 && b === 0 && c === 113
}

function privateIpv6(address: string) {
  const normalized = address.toLowerCase().split('%')[0] || ''
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7)
    return isIP(mapped) === 4 ? privateIpv4(mapped) : true
  }
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')
}

function privateAddress(address: string) {
  const version = isIP(address)
  return version === 4 ? privateIpv4(address) : version === 6 ? privateIpv6(address) : true
}

async function publicAddresses(url: URL) {
  let addresses: Array<{ address: string; family: 4 | 6 }>
  const literalFamily = isIP(url.hostname)
  if (literalFamily) addresses = [{ address: url.hostname, family: literalFamily as 4 | 6 }]
  else {
    try {
      addresses = (await lookup(url.hostname, { all: true, verbatim: true }))
        .map(item => ({ address: item.address, family: item.family as 4 | 6 }))
    } catch {
      throw createError({ statusCode: 422, message: '接码供应商域名无法解析' })
    }
  }
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) {
    throw createError({ statusCode: 400, message: '接码接口不能指向本机、内网或保留网络地址' })
  }
  return addresses
}

export async function validateSmsFetchUrl(value: unknown) {
  const url = parsedFetchUrl(value)
  await publicAddresses(url)
  return url
}

function providerError(error: unknown) {
  const typed = error as { code?: string; cause?: { code?: string; message?: string } }
  if (typed.code === 'ERR_TLS_CERT_ALTNAME_INVALID' || typed.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return '接码供应商 TLS 证书与域名不匹配'
  }
  const message = error instanceof Error ? error.message : '接码供应商请求失败'
  return message.replace(/https?:\/\/\S+/g, '[接码地址]').slice(0, 300)
}

function requestProvider(url: URL, address: { address: string; family: 4 | 6 }) {
  return new Promise<{ status: number; location: string | null; contentType: string; body: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
        'user-agent': 'Zephyr-Hub-SMS/1.0'
      },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [address])
        else callback(null, address.address, address.family)
      }
    }, (response) => {
      const declared = Number(response.headers['content-length'] || 0)
      if (declared > MAX_RESPONSE_BYTES) {
        clearTimeout(deadline)
        response.destroy()
        reject(new Error('接码供应商响应超过 256KB 上限'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('接码供应商响应超过 256KB 上限'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', (error) => {
        clearTimeout(deadline)
        reject(error)
      })
      response.on('end', () => {
        clearTimeout(deadline)
        resolve({
          status: response.statusCode || 0,
          location: typeof response.headers.location === 'string' ? response.headers.location : null,
          contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : '',
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    const deadline = setTimeout(() => request.destroy(new Error('接码供应商响应超时')), FETCH_TIMEOUT_MS)
    request.on('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    request.end()
  })
}

function collectStrings(value: unknown, output: string[], depth = 0) {
  if (depth > 5 || output.length >= 100) return
  if (typeof value === 'string') {
    const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
    if (normalized) output.push(normalized)
    return
  }
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach(item => collectStrings(item, output, depth + 1))
    return
  }
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    const preferred = ['code', 'smsCode', 'verificationCode', 'otp', 'message', 'text', 'content', 'sms', 'data', 'records', 'list']
    const keys = [...preferred.filter(key => key in record), ...Object.keys(record).filter(key => !preferred.includes(key))]
    keys.slice(0, 50).forEach(key => collectStrings(record[key], output, depth + 1))
  }
}

function collectExplicitCodes(value: unknown, output: string[], depth = 0) {
  if (depth > 5 || output.length >= 20 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach(item => collectExplicitCodes(item, output, depth + 1))
    return
  }
  const record = value as UnknownRecord
  const codeKeys = new Set(['code', 'smscode', 'verificationcode', 'otp'])
  Object.entries(record).slice(0, 50).forEach(([key, candidate]) => {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '')
    if (codeKeys.has(normalizedKey)) {
      const normalized = typeof candidate === 'number' && Number.isInteger(candidate)
        ? String(candidate)
        : typeof candidate === 'string' ? candidate.trim() : ''
      if (/^\d{6}$/.test(normalized)) output.push(normalized)
    }
    collectExplicitCodes(candidate, output, depth + 1)
  })
}

export function parseSmsProviderResponse(raw: string, contentType = '') {
  const normalized = raw.trim()
  let parsed: unknown = normalized
  if (contentType.includes('json') || /^[{[]/.test(normalized)) {
    try { parsed = JSON.parse(normalized) } catch { parsed = normalized }
  }
  const strings: string[] = []
  collectStrings(parsed, strings)
  if (!strings.length && normalized) strings.push(normalized)
  const explicitCodes: string[] = []
  collectExplicitCodes(parsed, explicitCodes)
  const uniqueExplicitCodes = new Set(explicitCodes)
  const keywordPatterns = [
    /(?:验证代码|验证码|短信代码|校验码|动态码|安全码|verification\s*code|security\s*code|otp|code)[^\d]{0,30}(\d{6})(?!\d)/i,
    /(?<!\d)(\d{6})[^\d]{0,30}(?:是您|为您|验证代码|验证码|短信代码|校验码|verification\s*code|otp|code)/i
  ]
  let code: string | null = uniqueExplicitCodes.size === 1 ? [...uniqueExplicitCodes][0] || null : null
  for (const candidate of strings) {
    if (code) break
    for (const pattern of keywordPatterns) {
      const match = candidate.match(pattern)
      if (match?.[1]) { code = match[1]; break }
    }
    if (code) break
  }
  if (!code) {
    const possibleCodes = new Set<string>()
    for (const candidate of strings) {
      if (/(?:\bno\s*sms\b|暂无短信|没有短信|无短信|已过期|expired|pending)/i.test(candidate)) continue
      const sanitized = candidate
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|id)\s*[:=]\s*\d{6}\b/gi, ' ')
        .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g, ' ')
        .replace(/[+()]?(?:\d[\s().-]*){10,15}/g, ' ')
      for (const match of sanitized.matchAll(/(?<!\d)(\d{6})(?!\d)/g)) {
        if (match[1]) possibleCodes.add(match[1])
      }
    }
    if (possibleCodes.size === 1) code = [...possibleCodes][0] || null
  }
  const message = (strings.find(value => value !== code) || (code ? '已获取新的短信验证码' : '供应商未返回短信')).slice(0, 500)
  return { code, message }
}

async function fetchProvider(url: URL) {
  let current = url
  for (let redirects = 0; redirects <= 3; redirects++) {
    const [address] = await publicAddresses(current)
    if (!address) throw new Error('接码供应商域名没有可用公网地址')
    const response = await requestProvider(current, address)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.location
      if (!location) throw new Error('接码供应商返回了无地址的重定向')
      if (redirects === 3) throw new Error('接码供应商重定向次数过多')
      current = new URL(location, current)
      if (!['http:', 'https:'].includes(current.protocol)) throw new Error('接码供应商重定向到了不支持的协议')
      if (current.username || current.password) throw new Error('接码供应商重定向地址包含不允许的凭据')
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`接码供应商返回 HTTP ${response.status}`)
    return parseSmsProviderResponse(response.body, response.contentType)
  }
  throw new Error('接码供应商重定向次数过多')
}

async function receiverRow(event: H3Event, id: string) {
  const [row] = await useDatabase(event).select().from(smsReceivers).where(eq(smsReceivers.id, id)).limit(1)
  if (!row) throw createError({ statusCode: 404, message: '接码资源不存在' })
  return row
}

export async function listSmsReceivers(event: H3Event): Promise<SmsReceiverView[]> {
  const db = useDatabase(event)
  const [receivers, bindings] = await Promise.all([
    db.select().from(smsReceivers).orderBy(asc(smsReceivers.phone)),
    db.select({
      bindingId: smsReceiverBindings.id,
      receiverId: smsReceiverBindings.receiverId,
      accountId: smsReceiverBindings.accountId,
      slot: smsReceiverBindings.slot,
      email: smsReceiverBindings.accountEmail,
      displayName: smsReceiverBindings.accountDisplayName,
      deletedAt: smsReceiverBindings.deletedAt
    }).from(smsReceiverBindings)
  ])
  return receivers.map(receiver => {
    const presentedPhone = smsPhonePresentation(receiver.phone)
    const receiverBindings = bindings.filter(item => item.receiverId === receiver.id)
    const accounts = receiverBindings.map(item => ({
      bindingId: item.bindingId,
      id: item.accountId || `deleted:${item.bindingId}`,
      email: item.email,
      displayName: item.displayName,
      slot: item.slot,
      deleted: Boolean(item.deletedAt),
      manual: Boolean(!item.accountId && !item.deletedAt)
    })).sort((left, right) => left.slot - right.slot)
    return {
      id: receiver.id,
      phone: presentedPhone.phone,
      copyValue: presentedPhone.copyValue,
      providerHost: receiver.providerHost,
      note: receiver.note,
      status: receiver.status as 'active' | 'disabled',
      bindingCount: accounts.length,
      availableSlots: MAX_SMS_RECEIVER_BINDINGS - accounts.length,
      readyForDeletion: isSmsReceiverReadyForDeletion(receiverBindings),
      accounts,
      lastFetchedAt: receiver.lastFetchedAt?.getTime() || null,
      lastFetchStatus: receiver.lastFetchStatus,
      lastFetchError: receiver.lastFetchError,
      createdAt: receiver.createdAt.getTime(),
      updatedAt: receiver.updatedAt.getTime()
    }
  })
}

export async function accountSmsReceiverMap(event: H3Event) {
  const [bindings, receivers] = await Promise.all([
    useDatabase(event).select().from(smsReceiverBindings),
    useDatabase(event).select().from(smsReceivers)
  ])
  const receiverMap = new Map(receivers.map(receiver => [receiver.id, receiver]))
  const counts = new Map<string, number>()
  bindings.forEach(binding => counts.set(binding.receiverId, (counts.get(binding.receiverId) || 0) + 1))
  const result = new Map<string, AccountSmsReceiverView>()
  for (const binding of bindings) {
    if (!binding.accountId) continue
    const receiver = receiverMap.get(binding.receiverId)
    if (!receiver) continue
    const presentedPhone = smsPhonePresentation(receiver.phone)
    result.set(binding.accountId, {
      id: receiver.id,
      phone: presentedPhone.phone,
      copyValue: presentedPhone.copyValue,
      providerHost: receiver.providerHost,
      bindingCount: counts.get(receiver.id) || 0,
      slot: binding.slot,
      codeReceivedAt: binding.codeReceivedAt?.getTime() || null,
      lastFetchedAt: receiver.lastFetchedAt?.getTime() || null,
      lastFetchStatus: receiver.lastFetchStatus
    })
  }
  return result
}

export async function createSmsReceiver(event: H3Event, body: UnknownRecord, actorId: string) {
  const { phone, phoneKey } = normalizeSmsPhone(body.phone)
  const url = await validateSmsFetchUrl(body.fetchUrl)
  const [existing] = await useDatabase(event).select({ id: smsReceivers.id }).from(smsReceivers).where(eq(smsReceivers.phoneKey, phoneKey)).limit(1)
  if (existing) throw createError({ statusCode: 409, message: '这个手机号已经存在于接码管理中' })
  const id = randomUUID()
  const [created] = await useDatabase(event).insert(smsReceivers).values({
    id,
    phone,
    phoneKey,
    providerHost: url.hostname,
    encryptedFetchUrl: encryptContextSecret(url.toString(), smsContext(id), event),
    note: text(body.note, '接码备注', 500) || null,
    status: receiverStatus(body.status),
    createdBy: actorId,
    updatedBy: actorId
  }).returning()
  if (!created) throw createError({ statusCode: 500, message: '创建接码资源失败' })
  return (await listSmsReceivers(event)).find(item => item.id === id)!
}

export async function importSmsReceivers(event: H3Event, value: unknown, actorId: string): Promise<SmsReceiverImportResult> {
  const parsed = parseSmsReceiverImportText(value)
  const skipped: SmsReceiverImportResult['skipped'] = []
  const failed = [...parsed.failed]
  const uniqueCandidates: SmsReceiverImportCandidate[] = []
  const seenPhoneKeys = new Set<string>()
  for (const candidate of parsed.candidates) {
    if (seenPhoneKeys.has(candidate.phoneKey)) {
      skipped.push({ line: candidate.line, phone: candidate.phone, reason: '同一批次手机号重复' })
      continue
    }
    seenPhoneKeys.add(candidate.phoneKey)
    uniqueCandidates.push(candidate)
  }

  const hostErrors = new Map<string, string | null>()
  for (const candidate of uniqueCandidates) {
    const host = candidate.url.hostname.toLowerCase()
    if (hostErrors.has(host)) continue
    try {
      await publicAddresses(candidate.url)
      hostErrors.set(host, null)
    } catch (error) {
      hostErrors.set(host, serviceErrorMessage(error, '接码供应商域名校验失败'))
    }
  }
  const addressSafeCandidates = uniqueCandidates.filter((candidate) => {
    const error = hostErrors.get(candidate.url.hostname.toLowerCase())
    if (!error) return true
    failed.push({ line: candidate.line, phone: candidate.phone, error })
    return false
  })

  const db = useDatabase(event)
  const existingRows = addressSafeCandidates.length
    ? await db.select({ phoneKey: smsReceivers.phoneKey }).from(smsReceivers)
        .where(inArray(smsReceivers.phoneKey, addressSafeCandidates.map(item => item.phoneKey)))
    : []
  const existingKeys = new Set(existingRows.map(item => item.phoneKey))
  const insertCandidates = addressSafeCandidates.filter((candidate) => {
    if (!existingKeys.has(candidate.phoneKey)) return true
    skipped.push({ line: candidate.line, phone: candidate.phone, reason: '手机号已存在' })
    return false
  })

  const values = insertCandidates.map((candidate) => {
    const id = randomUUID()
    return {
      id,
      phone: candidate.phone,
      phoneKey: candidate.phoneKey,
      providerHost: candidate.url.hostname,
      encryptedFetchUrl: encryptContextSecret(candidate.url.toString(), smsContext(id), event),
      status: 'active',
      createdBy: actorId,
      updatedBy: actorId
    }
  })
  const inserted = values.length
    ? await db.insert(smsReceivers).values(values).onConflictDoNothing({ target: smsReceivers.phoneKey }).returning({
        id: smsReceivers.id,
        phoneKey: smsReceivers.phoneKey,
        phone: smsReceivers.phone,
        providerHost: smsReceivers.providerHost
      })
    : []
  const insertedByKey = new Map(inserted.map(item => [item.phoneKey, item]))
  const created: SmsReceiverImportResult['created'] = []
  for (const candidate of insertCandidates) {
    const item = insertedByKey.get(candidate.phoneKey)
    if (item) created.push({ line: candidate.line, id: item.id, phone: item.phone, providerHost: item.providerHost })
    else skipped.push({ line: candidate.line, phone: candidate.phone, reason: '手机号已被其他请求导入' })
  }
  return { created, skipped, failed: failed.sort((left, right) => left.line - right.line) }
}

export async function updateSmsReceiver(event: H3Event, id: string, body: UnknownRecord, actorId: string) {
  const current = await receiverRow(event, id)
  const { phone, phoneKey } = body.phone === undefined ? current : normalizeSmsPhone(body.phone)
  const fetchUrl = typeof body.fetchUrl === 'string' && body.fetchUrl.trim() ? await validateSmsFetchUrl(body.fetchUrl) : null
  const [duplicate] = await useDatabase(event).select({ id: smsReceivers.id }).from(smsReceivers).where(eq(smsReceivers.phoneKey, phoneKey)).limit(1)
  if (duplicate && duplicate.id !== id) throw createError({ statusCode: 409, message: '这个手机号已经存在于接码管理中' })
  const status = receiverStatus(body.status, current.status as 'active' | 'disabled')
  const [updated] = await useDatabase(event).update(smsReceivers).set({
    phone,
    phoneKey,
    ...(fetchUrl ? {
      providerHost: fetchUrl.hostname,
      encryptedFetchUrl: encryptContextSecret(fetchUrl.toString(), smsContext(id), event)
    } : {}),
    note: body.note === undefined ? current.note : text(body.note, '接码备注', 500) || null,
    status,
    updatedBy: actorId,
    updatedAt: new Date()
  }).where(eq(smsReceivers.id, id)).returning()
  if (!updated) throw createError({ statusCode: 500, message: '更新接码资源失败' })
  return (await listSmsReceivers(event)).find(item => item.id === id)!
}

export async function deleteSmsReceiver(event: H3Event, id: string) {
  const receiver = await receiverRow(event, id)
  const bindings = await useDatabase(event).select({
    accountId: smsReceiverBindings.accountId,
    deletedAt: smsReceiverBindings.deletedAt
  }).from(smsReceiverBindings).where(eq(smsReceiverBindings.receiverId, id))
  if (bindings.length && !isSmsReceiverReadyForDeletion(bindings)) {
    throw createError({ statusCode: 409, message: '接码资源仍绑定有效账号，请先解除全部绑定' })
  }
  await useDatabase(event).delete(smsReceivers).where(eq(smsReceivers.id, id))
  return { id, phone: receiver.phone }
}

export async function deleteSmsReceiverBinding(event: H3Event, receiverId: string, bindingId: string) {
  const db = useDatabase(event)
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('zephyr_sms_receiver_allocation'))`)
  const [binding] = await db.select().from(smsReceiverBindings).where(and(
    eq(smsReceiverBindings.id, bindingId),
    eq(smsReceiverBindings.receiverId, receiverId)
  )).limit(1)
  if (!binding) throw createError({ statusCode: 404, message: '接码账号绑定不存在' })
  await db.delete(smsReceiverBindings).where(eq(smsReceiverBindings.id, bindingId))
  return {
    id: binding.id,
    receiverId: binding.receiverId,
    accountId: binding.accountId,
    email: binding.accountEmail,
    deletedAccount: Boolean(binding.deletedAt)
  }
}

export async function addManualSmsReceiverBinding(event: H3Event, receiverId: string, body: UnknownRecord, actorId: string) {
  const db = useDatabase(event)
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('zephyr_sms_receiver_allocation'))`)
  const receiver = await receiverRow(event, receiverId)
  if (receiver.status !== 'active') throw createError({ statusCode: 409, message: '停用的接码资源不能添加占用' })
  const used = await db.select({ slot: smsReceiverBindings.slot }).from(smsReceiverBindings)
    .where(eq(smsReceiverBindings.receiverId, receiverId))
  const slot = firstAvailableSmsSlot(used.map(item => item.slot))
  if (!slot) throw createError({ statusCode: 409, message: '这个手机号已经绑定 3 个账号，请先解除一个占用' })
  const email = text(body.email, '绑定账号标识', 320, true)
  const displayName = text(body.displayName, '账号名称', 200) || null
  try {
    const [created] = await db.insert(smsReceiverBindings).values({
      receiverId,
      accountId: null,
      accountEmail: email,
      accountDisplayName: displayName,
      slot,
      createdBy: actorId
    }).returning()
    if (!created) throw createError({ statusCode: 500, message: '添加手动占用失败' })
    return created
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw createError({ statusCode: 409, message: '接码资源的名额刚刚已被占用，请刷新后重试' })
    }
    throw error
  }
}

export async function bindAccountSmsReceiver(event: H3Event, accountId: string, receiverId: string | null, actorId: string) {
  const db = useDatabase(event)
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('zephyr_sms_receiver_allocation'))`)
  const [account] = await db.select({
    id: accountVaultEntries.id,
    email: accountVaultEntries.email,
    displayName: accountVaultEntries.displayName
  }).from(accountVaultEntries).where(eq(accountVaultEntries.id, accountId)).limit(1)
  if (!account) throw createError({ statusCode: 404, message: '账号资料不存在' })
  const [current] = await db.select().from(smsReceiverBindings).where(eq(smsReceiverBindings.accountId, accountId)).limit(1)
  if (!receiverId) {
    if (current) await db.delete(smsReceiverBindings).where(eq(smsReceiverBindings.id, current.id))
    return null
  }
  const receiver = await receiverRow(event, receiverId)
  if (receiver.status !== 'active') throw createError({ statusCode: 409, message: '停用的接码资源不能绑定账号' })
  if (current?.receiverId === receiverId) return current
  const used = await db.select({ slot: smsReceiverBindings.slot }).from(smsReceiverBindings).where(eq(smsReceiverBindings.receiverId, receiverId))
  const slot = firstAvailableSmsSlot(used.map(item => item.slot))
  if (!slot) throw createError({ statusCode: 409, message: '这个手机号已经绑定 3 个账号，请选择其他接码资源' })
  if (current) await db.delete(smsReceiverBindings).where(eq(smsReceiverBindings.id, current.id))
  try {
    const [created] = await db.insert(smsReceiverBindings).values({
      receiverId,
      accountId,
      accountEmail: account.email,
      accountDisplayName: account.displayName,
      slot,
      createdBy: actorId
    }).returning()
    return created
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw createError({ statusCode: 409, message: '接码资源的 3 个名额刚刚已被占用，请刷新后重试' })
    }
    throw error
  }
}

export async function assignAvailableSmsReceiver(event: H3Event, accountId: string, actorId: string) {
  const db = useDatabase(event)
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('zephyr_sms_receiver_allocation'))`)
  const [receivers, bindings] = await Promise.all([
    db.select({ id: smsReceivers.id, createdAt: smsReceivers.createdAt }).from(smsReceivers)
      .where(eq(smsReceivers.status, 'active')).orderBy(asc(smsReceivers.createdAt)),
    db.select({ receiverId: smsReceiverBindings.receiverId }).from(smsReceiverBindings)
  ])
  const counts = new Map<string, number>()
  bindings.forEach(binding => counts.set(binding.receiverId, (counts.get(binding.receiverId) || 0) + 1))
  const receiverId = leastLoadedSmsReceiver(receivers, counts)
  if (!receiverId) return null
  return bindAccountSmsReceiver(event, accountId, receiverId, actorId)
}

export async function assertSmsReceiverAvailable(event: H3Event, receiverId: string) {
  const receiver = await receiverRow(event, receiverId)
  if (receiver.status !== 'active') throw createError({ statusCode: 409, message: '停用的接码资源不能绑定账号' })
  const bindings = await useDatabase(event).select({ id: smsReceiverBindings.id }).from(smsReceiverBindings)
    .where(eq(smsReceiverBindings.receiverId, receiverId))
  if (bindings.length >= MAX_SMS_RECEIVER_BINDINGS) throw createError({ statusCode: 409, message: '这个手机号已经绑定 3 个账号，请选择其他接码资源' })
  return receiver
}

export function firstAvailableSmsSlot(usedSlots: number[]) {
  return Array.from({ length: MAX_SMS_RECEIVER_BINDINGS }, (_, index) => index + 1)
    .find(slot => !usedSlots.includes(slot))
}

export function leastLoadedSmsReceiver(
  receivers: Array<{ id: string; createdAt: Date }>,
  bindingCounts: ReadonlyMap<string, number>
) {
  return receivers
    .filter(receiver => (bindingCounts.get(receiver.id) || 0) < MAX_SMS_RECEIVER_BINDINGS)
    .sort((left, right) => (bindingCounts.get(left.id) || 0) - (bindingCounts.get(right.id) || 0)
      || left.createdAt.getTime() - right.createdAt.getTime())[0]?.id
}

export async function ensureLegacySmsReceiver(event: H3Event, phoneValue: unknown, urlValue: unknown, actorId: string) {
  if (!phoneValue || !urlValue) return null
  const { phoneKey } = normalizeSmsPhone(phoneValue)
  const [existing] = await useDatabase(event).select({ id: smsReceivers.id }).from(smsReceivers).where(eq(smsReceivers.phoneKey, phoneKey)).limit(1)
  if (existing) return existing.id
  return (await createSmsReceiver(event, { phone: phoneValue, fetchUrl: urlValue, note: '由旧账号资料迁移' }, actorId)).id
}

export async function revealSmsReceiverFetchUrl(event: H3Event, id: string) {
  const receiver = await receiverRow(event, id)
  try { return decryptContextSecret(receiver.encryptedFetchUrl, smsContext(id), event) } catch {
    throw createError({ statusCode: 500, message: '接码接口密文无法解密，请检查加密密钥配置' })
  }
}

export async function refreshSmsReceiverCode(event: H3Event, id: string): Promise<SmsCodeResult> {
  const receiver = await receiverRow(event, id)
  if (receiver.status !== 'active') throw createError({ statusCode: 409, message: '接码资源已停用' })
  const fetchedAt = Date.now()
  try {
    const url = await validateSmsFetchUrl(decryptContextSecret(receiver.encryptedFetchUrl, smsContext(id), event))
    const result = await fetchProvider(url)
    await useDatabase(event).update(smsReceivers).set({
      lastFetchedAt: new Date(fetchedAt),
      lastFetchStatus: result.code ? 'code_received' : 'no_code',
      lastFetchError: null,
      updatedAt: new Date()
    }).where(eq(smsReceivers.id, id))
    return { receiverId: id, phone: receiver.phone, code: result.code, message: result.message, fetchedAt }
  } catch (error) {
    const message = providerError(error)
    await useDatabase(event).update(smsReceivers).set({
      lastFetchedAt: new Date(fetchedAt),
      lastFetchStatus: 'error',
      lastFetchError: message,
      updatedAt: new Date()
    }).where(eq(smsReceivers.id, id))
    throw createError({ statusCode: 502, message })
  }
}

export async function refreshAccountSmsReceiverCode(event: H3Event, accountId: string): Promise<SmsCodeResult> {
  const [binding] = await useDatabase(event).select().from(smsReceiverBindings)
    .where(eq(smsReceiverBindings.accountId, accountId)).limit(1)
  if (!binding) throw createError({ statusCode: 409, message: '该账号尚未分配接码手机号' })
  const result = await refreshSmsReceiverCode(event, binding.receiverId)
  if (result.code) {
    const verifiedAt = new Date(result.fetchedAt)
    await useDatabase(event).transaction(async (transaction) => {
      await transaction.update(smsReceiverBindings).set({ codeReceivedAt: verifiedAt })
        .where(eq(smsReceiverBindings.id, binding.id))
      await transaction.update(accountVaultEntries).set({
        smsVerifiedAt: verifiedAt,
        updatedAt: verifiedAt
      }).where(eq(accountVaultEntries.id, accountId))
    })
  }
  return result
}
