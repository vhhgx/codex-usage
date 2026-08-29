import type { H3Event } from 'h3'
import { getRequestHeaders } from 'h3'
import type { ChannelProtocol } from '#shared/types/hub'

const CLIENT_IDENTITY_HEADERS = new Set([
  'user-agent',
  'originator',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-retry-count',
  'x-stainless-timeout'
])

export function copyUpstreamClientIdentity(event: H3Event, target: Headers) {
  for (const [name, value] of Object.entries(getRequestHeaders(event))) {
    if (CLIENT_IDENTITY_HEADERS.has(name.toLowerCase()) && value !== undefined) target.set(name, String(value))
  }
  return target
}

/**
 * Return only an identity that looks like the CLI the upstream is expecting.
 * Browser requests can carry a user-agent too, but forwarding that value in a
 * passthrough model-discovery request would make a web click look like a
 * Claude/Codex request and can incorrectly unlock an identity-gated provider.
 */
export function requestUpstreamClientIdentity(event: H3Event, protocol: ChannelProtocol): Record<string, string> {
  const copied = new Headers()
  copyUpstreamClientIdentity(event, copied)
  const userAgent = copied.get('user-agent') || ''
  const originator = copied.get('originator') || ''
  const looksLikeClaude = /claude(?:[-_ ]?code|[-_ ]?cli)/i.test(`${userAgent} ${originator}`)
  const looksLikeCodex = /codex/i.test(`${userAgent} ${originator}`)
  if (protocol === 'anthropic_messages' && !looksLikeClaude) return {}
  if (protocol !== 'anthropic_messages' && !looksLikeCodex) return {}
  return Object.fromEntries(copied.entries())
}

export function isUpstreamClientIdentityHeader(name: string) {
  return CLIENT_IDENTITY_HEADERS.has(name.toLowerCase())
}

export function upstreamProbeClientIdentity(protocol: ChannelProtocol): Record<string, string> {
  if (protocol === 'anthropic_messages') {
    return { 'user-agent': 'claude-cli/2.1.232 (external, cli)' }
  }
  return { 'user-agent': 'codex_cli_rs/0.80.0', originator: 'codex_cli_rs' }
}
