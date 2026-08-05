import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import type { SubAccountManagementView } from '#shared/types/upstream-management'
import { useRedis } from '../utils/redis'
import {
  createManagedSub2ApiOpenAiOAuthAccount,
  getManagedSub2ApiProxyState,
  resolveSub2ApiGroupIds,
  resolveSub2ApiProxySelection,
  sub2ApiAdminFetch
} from './sub2api-admin'

const FLOW_TTL_SECONDS = 30 * 60
const FLOW_LOCK_SECONDS = 5 * 60

interface StoredOAuthFlow {
  adminId: string
  sessionId: string
  proxyId: string | null
  accountVaultId: string | null
  expiresAt: number
}

interface OAuthAccountInput {
  flowId: unknown
  callbackUrl: unknown
  name: unknown
  concurrency: unknown
  priority: unknown
  groupIds: unknown
  schedulable: unknown
  accountVaultId?: unknown
}

function oauthFlowKey(flowId: string) {
  const digest = createHash('sha256').update(flowId).digest('hex')
  return `hub:sub2api-oauth:${digest}`
}

function stringValue(value: unknown, field: string, max: number, required = false) {
  const parsed = typeof value === 'string' ? value.trim() : ''
  if (required && !parsed) throw createError({ statusCode: 400, message: `${field} 不能为空` })
  if (parsed.length > max) throw createError({ statusCode: 400, message: `${field} 过长` })
  return parsed
}

function integerValue(value: unknown, field: string, fallback: number, min: number, max: number) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw createError({ statusCode: 400, message: `${field} 超出有效范围` })
  }
  return parsed
}

function normalizeFlowId(value: unknown) {
  const flowId = stringValue(value, 'OAuth 流程 ID', 128, true)
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(flowId)) {
    throw createError({ statusCode: 400, message: 'OAuth 流程 ID 无效' })
  }
  return flowId
}

export function parseSub2ApiOpenAiCallback(value: unknown) {
  const raw = stringValue(value, 'localhost 回调 URL', 8192, true)
  let callback: URL
  try {
    callback = new URL(raw)
  } catch {
    throw createError({ statusCode: 400, message: 'localhost 回调 URL 格式无效' })
  }
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== 'localhost' ||
    callback.port !== '1455' ||
    callback.pathname !== '/auth/callback' ||
    callback.username ||
    callback.password
  ) {
    throw createError({
      statusCode: 400,
      message: '请粘贴 http://localhost:1455/auth/callback 开头的完整回调 URL'
    })
  }
  if (callback.searchParams.has('error')) {
    throw createError({ statusCode: 400, message: 'OpenAI 未完成授权，请重新生成链接后再试' })
  }
  const code = callback.searchParams.get('code')?.trim() || ''
  const state = callback.searchParams.get('state')?.trim() || ''
  if (!code || code.length > 4096) {
    throw createError({ statusCode: 400, message: '回调 URL 中缺少有效的授权码' })
  }
  if (!state || state.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(state)) {
    throw createError({ statusCode: 400, message: '回调 URL 中缺少有效的 OAuth state' })
  }
  return { code, state }
}

function parseStoredFlow(raw: string | null, adminId: string): StoredOAuthFlow {
  if (!raw) throw createError({ statusCode: 410, message: 'OAuth 授权流程已过期，请重新生成链接' })
  try {
    const flow = JSON.parse(raw) as Partial<StoredOAuthFlow>
    if (
      flow.adminId !== adminId ||
      typeof flow.sessionId !== 'string' ||
      !flow.sessionId ||
      typeof flow.expiresAt !== 'number' ||
      flow.expiresAt <= Date.now() ||
      !(flow.proxyId === null || typeof flow.proxyId === 'string')
    ) throw new Error('invalid flow')
    return { ...flow, accountVaultId: typeof flow.accountVaultId === 'string' ? flow.accountVaultId : null } as StoredOAuthFlow
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error
    throw createError({ statusCode: 410, message: 'OAuth 授权流程无效，请重新生成链接' })
  }
}

export async function startManagedSub2ApiOpenAiOAuth(event: H3Event, input: {
  adminId: string
  proxyId: unknown
  useDefaultProxy: boolean
  accountVaultId?: unknown
}) {
  const selectedProxyId = input.useDefaultProxy
    ? (await getManagedSub2ApiProxyState(event)).defaultProxyId
    : input.proxyId === null || input.proxyId === '' ? null : stringValue(input.proxyId, '账号代理', 128, true)
  const upstreamProxyId = await resolveSub2ApiProxySelection(event, selectedProxyId, false)
  const requestBody = upstreamProxyId ? { proxy_id: upstreamProxyId } : {}
  const result = await sub2ApiAdminFetch<Record<string, unknown>>(event, '/openai/generate-auth-url', {
    method: 'POST',
    body: requestBody
  })
  const authorizationUrl = stringValue(result.auth_url, 'Sub2API 授权链接', 16_384, true)
  const sessionId = stringValue(result.session_id, 'Sub2API OAuth session', 256, true)
  let parsed: URL
  try {
    parsed = new URL(authorizationUrl)
  } catch {
    throw createError({ statusCode: 502, message: 'Sub2API 返回的授权链接格式无效' })
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'auth.openai.com') {
    throw createError({ statusCode: 502, message: 'Sub2API 返回了非 OpenAI 官方域名的授权链接' })
  }
  const flowId = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + FLOW_TTL_SECONDS * 1000
  const stored: StoredOAuthFlow = {
    adminId: input.adminId,
    sessionId,
    proxyId: selectedProxyId,
    accountVaultId: input.accountVaultId === undefined || input.accountVaultId === null || input.accountVaultId === ''
      ? null
      : stringValue(input.accountVaultId, '本地账号 ID', 128, true),
    expiresAt
  }
  await useRedis(event).set(oauthFlowKey(flowId), JSON.stringify(stored), 'EX', FLOW_TTL_SECONDS)
  return { authorizationUrl, flowId, expiresAt }
}

export async function completeManagedSub2ApiOpenAiOAuth(
  event: H3Event,
  adminId: string,
  input: OAuthAccountInput
): Promise<SubAccountManagementView> {
  const flowId = normalizeFlowId(input.flowId)
  const callback = parseSub2ApiOpenAiCallback(input.callbackUrl)
  const name = stringValue(input.name, '账号名称', 160)
  const concurrency = integerValue(input.concurrency, '并发数', 10, 1, 10_000)
  const priority = integerValue(input.priority, '优先级', 0, 0, 1_000_000)
  const schedulable = input.schedulable !== false
  const redis = useRedis(event)
  const key = oauthFlowKey(flowId)
  const lockKey = `${key}:lock`
  const locked = await redis.set(lockKey, adminId, 'EX', FLOW_LOCK_SECONDS, 'NX')
  if (!locked) throw createError({ statusCode: 409, message: '该 OAuth 回调正在处理中，请稍候刷新账号列表' })
  try {
    const flow = parseStoredFlow(await redis.get(key), adminId)
    const accountVaultId = input.accountVaultId === undefined || input.accountVaultId === null || input.accountVaultId === ''
      ? null
      : stringValue(input.accountVaultId, '本地账号 ID', 128, true)
    if (flow.accountVaultId !== accountVaultId) throw createError({ statusCode: 409, message: 'OAuth 流程与当前账号不匹配，请重新生成授权链接' })
    const [groupIds, proxyId] = await Promise.all([
      resolveSub2ApiGroupIds(event, input.groupIds || []),
      resolveSub2ApiProxySelection(event, flow.proxyId, false)
    ])
    try {
      const account = await createManagedSub2ApiOpenAiOAuthAccount(event, {
        sessionId: flow.sessionId,
        code: callback.code,
        state: callback.state,
        name,
        concurrency,
        priority,
        groupIds,
        proxyId,
        schedulable
      })
      await redis.del(key)
      return account
    } catch (error) {
      if ((error as { data?: { reconciliationRequired?: boolean } }).data?.reconciliationRequired) {
        await redis.del(key)
      }
      throw error
    }
  } finally {
    await redis.del(lockKey)
  }
}

export function sub2ApiOAuthFingerprint(value: unknown) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}
