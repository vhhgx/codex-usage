import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { createError } from 'h3'
import { Agent, fetch as undiciFetch } from 'undici'
import { redactSensitiveText } from './upstream'

const ALLOWED_RANGES = new Set(['unicast'])
const TUN_FAKE_IP_RANGE = ipaddr.parseCIDR('198.18.0.0/15')

export function isPublicUpstreamAddress(value: string) {
  if (!ipaddr.isValid(value)) return false
  let address = ipaddr.parse(value)
  if (address.kind() === 'ipv6') {
    const ipv6 = address as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) address = ipv6.toIPv4Address()
  }
  return ALLOWED_RANGES.has(address.range())
}

export function isTunFakeIpAddress(value: string) {
  if (!ipaddr.isValid(value)) return false
  let address = ipaddr.parse(value)
  if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) address = (address as ipaddr.IPv6).toIPv4Address()
  return address.kind() === 'ipv4' && address.match(TUN_FAKE_IP_RANGE)
}

function allowTunFakeIpForHostname(hostname: string) {
  return process.env.NUXT_ALLOW_TUN_FAKE_IP_UPSTREAMS === 'true' && !ipaddr.isValid(hostname)
}

export function normalizeUserUpstreamUrl(raw: string) {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw createError({ statusCode: 400, message: '中转地址格式不正确' }) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw createError({ statusCode: 400, message: '用户中转只允许使用 HTTP 或 HTTPS' })
  if (url.username || url.password || url.search || url.hash) throw createError({ statusCode: 400, message: '中转地址不能包含凭据、查询参数或片段' })
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export async function resolvePublicUpstream(raw: string) {
  const normalized = normalizeUserUpstreamUrl(raw)
  const url = new URL(normalized)
  let addresses: Array<{ address: string; family: 4 | 6 }>
  try {
    const results = await lookup(url.hostname, { all: true, verbatim: true })
    addresses = results.map(result => ({ address: result.address, family: result.family as 4 | 6 }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DNS 解析失败'
    throw createError({ statusCode: 400, message: `无法解析中转地址：${message}` })
  }
  const allowTunFakeIp = allowTunFakeIpForHostname(url.hostname)
  if (!addresses.length || addresses.some(item => !isPublicUpstreamAddress(item.address) && !(allowTunFakeIp && isTunFakeIpAddress(item.address)))) {
    throw createError({ statusCode: 400, message: '中转地址解析到了不允许访问的网络' })
  }
  return { normalized, url, addresses: addresses.slice(0, 8) }
}

type ErrorRecord = { message?: unknown; code?: unknown; errno?: unknown; syscall?: unknown; cause?: unknown }

export function upstreamNetworkError(error: unknown) {
  const messages: string[] = []
  const codes: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    const item = current as ErrorRecord
    const message = redactSensitiveText(item.message)
    const code = typeof item.code === 'string' ? item.code : typeof item.errno === 'string' ? item.errno : ''
    const syscall = typeof item.syscall === 'string' ? item.syscall : ''
    if (message && message.toLowerCase() !== 'fetch failed' && !messages.includes(message)) messages.push(message)
    if (code && !codes.includes(code)) codes.push(code)
    if (syscall && !messages.includes(syscall)) messages.push(syscall)
    current = item.cause
  }
  const code = codes.join('/') || 'UPSTREAM_FETCH_FAILED'
  const message = messages.join(': ') || '上游连接失败'
  return { code: code.slice(0, 120), message: message.slice(0, 500) }
}

export function userUpstreamTarget(raw: string, path: string) {
  const normalized = normalizeUserUpstreamUrl(raw)
  return `${normalized.replace(/\/v1$/i, '')}${path.startsWith('/') ? path : `/${path}`}`
}

async function pinnedResolvedFetch(
  resolved: Awaited<ReturnType<typeof resolvePublicUpstream>>,
  target: string,
  init: Parameters<typeof undiciFetch>[1]
) {
  const failures: Array<{ address: string; code: string; message: string }> = []
  const candidates = [...resolved.addresses].sort((left, right) => left.family - right.family)
  for (const selected of candidates) {
    const agent = new Agent({
      connect: {
        timeout: 10_000,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [selected])
          else callback(null, selected.address, selected.family)
        }
      }
    })
    try {
      const response = await undiciFetch(target, {
        ...init,
        dispatcher: agent,
        redirect: 'manual'
      })
      return { response, close: () => agent.close(), address: selected.address, target }
    } catch (error) {
      await agent.close().catch(() => {})
      const detail = upstreamNetworkError(error)
      failures.push({ address: selected.address, ...detail })
      if (init?.signal?.aborted) break
    }
  }
  const summary = failures.map(item => `${item.address} [${item.code}] ${item.message}`).join('; ')
  const failure = new Error(`所有已解析地址均连接失败：${summary || '没有可用地址'}`)
  Object.assign(failure, { code: 'UPSTREAM_ALL_ADDRESSES_FAILED', failures, target })
  throw failure
}

export async function pinnedUpstreamFetch(raw: string, path: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const resolved = await resolvePublicUpstream(raw)
  return pinnedResolvedFetch(resolved, userUpstreamTarget(resolved.normalized, path), init)
}

export async function pinnedUpstreamBaseFetch(raw: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const resolved = await resolvePublicUpstream(raw)
  return pinnedResolvedFetch(resolved, resolved.normalized, init)
}
