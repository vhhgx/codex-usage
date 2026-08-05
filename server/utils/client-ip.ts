import { BlockList, isIP } from 'node:net'
import type { H3Event } from 'h3'

let cachedProxies: { source: string; blockList: BlockList } | null = null

function normalizeIp(value: string) {
  const trimmed = value.trim().replace(/^\[|\]$/g, '').split('%', 1)[0] || ''
  return trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed
}

function trustedProxies(event: H3Event) {
  const source = String(useRuntimeConfig(event).trustedProxyCidrs || '').trim()
  if (cachedProxies?.source === source) return cachedProxies.blockList
  const blockList = new BlockList()
  for (const entry of source.split(',').map(value => value.trim()).filter(Boolean)) {
    const [addressValue, prefixValue] = entry.split('/')
    const address = normalizeIp(addressValue || '')
    const family = isIP(address)
    if (!family) continue
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (prefixValue === undefined) {
      blockList.addAddress(address, type)
      continue
    }
    const prefix = Number(prefixValue)
    const maximum = family === 4 ? 32 : 128
    if (Number.isInteger(prefix) && prefix >= 0 && prefix <= maximum) {
      blockList.addSubnet(address, prefix, type)
    }
  }
  cachedProxies = { source, blockList }
  return blockList
}

function directAddress(event: H3Event) {
  return normalizeIp(event.node.req.socket.remoteAddress || '') || 'unknown'
}

function forwardedAddress(event: H3Event) {
  const raw = event.node.req.headers['x-forwarded-for']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return ''
  const address = normalizeIp(value.split(',', 1)[0] || '')
  return isIP(address) ? address : ''
}

export function trustedClientIp(event: H3Event) {
  const direct = directAddress(event)
  const family = isIP(direct)
  if (!family || !trustedProxies(event).check(direct, family === 4 ? 'ipv4' : 'ipv6')) return direct
  return forwardedAddress(event) || direct
}
