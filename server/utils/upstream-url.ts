import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { createError } from 'h3'
import { Agent, fetch as undiciFetch } from 'undici'

const ALLOWED_RANGES = new Set(['unicast'])

export function isPublicUpstreamAddress(value: string) {
  if (!ipaddr.isValid(value)) return false
  let address = ipaddr.parse(value)
  if (address.kind() === 'ipv6') {
    const ipv6 = address as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) address = ipv6.toIPv4Address()
  }
  return ALLOWED_RANGES.has(address.range())
}

export function normalizeUserUpstreamUrl(raw: string) {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw createError({ statusCode: 400, message: '中转地址格式不正确' }) }
  if (url.protocol !== 'https:') throw createError({ statusCode: 400, message: '用户中转只允许使用 HTTPS' })
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
  if (!addresses.length || addresses.some(item => !isPublicUpstreamAddress(item.address))) {
    throw createError({ statusCode: 400, message: '中转地址解析到了不允许访问的网络' })
  }
  return { normalized, url, addresses }
}

export async function pinnedUpstreamFetch(raw: string, path: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const resolved = await resolvePublicUpstream(raw)
  const selected = resolved.addresses[0]!
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
    }
  })
  const target = `${resolved.normalized.replace(/\/v1$/i, '')}${path.startsWith('/') ? path : `/${path}`}`
  try {
    const response = await undiciFetch(target, {
      ...init,
      dispatcher: agent,
      redirect: 'manual'
    })
    return { response, close: () => agent.close() }
  } catch (error) {
    await agent.close().catch(() => {})
    throw error
  }
}
