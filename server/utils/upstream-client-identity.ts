import type { H3Event } from 'h3'
import { getRequestHeaders } from 'h3'

const CLIENT_IDENTITY_HEADERS = new Set([
  'user-agent',
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

export function isUpstreamClientIdentityHeader(name: string) {
  return CLIENT_IDENTITY_HEADERS.has(name.toLowerCase())
}
