import type { ChannelAuthScheme } from '#shared/types/hub'

export interface AuthProbeResponse {
  ok: boolean
  status: number | null
  body: string
  /** The response only succeeds when a compatible CLI identity is present. */
  identityOnly?: boolean
}

export interface AuthProbeAttempt extends AuthProbeResponse {
  authScheme: ChannelAuthScheme
}

export function alternateAuthScheme(authScheme: ChannelAuthScheme): ChannelAuthScheme {
  return authScheme === 'bearer' ? 'x_api_key' : 'bearer'
}

export function upstreamAuthHeaders(authScheme: ChannelAuthScheme, apiKey: string, apiVersion?: string | null): Record<string, string> {
  return authScheme === 'x_api_key'
    ? { 'x-api-key': apiKey, 'anthropic-version': apiVersion || '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` }
}

export function isClientIdentityRejection(body: string) {
  return /unauthorized[ _-]client|client detected|coding agent client/i.test(body)
}

export async function probeAuthSchemes(
  current: ChannelAuthScheme,
  request: (authScheme: ChannelAuthScheme) => Promise<AuthProbeResponse>
) {
  const attempts: AuthProbeAttempt[] = []
  const first = await request(current)
  attempts.push({ authScheme: current, ...first })
  if (!first.identityOnly && (first.ok || (first.status !== 401 && first.status !== 403))) {
    return { ok: first.ok, selectedAuthScheme: first.ok ? current : null, changed: false, attempts }
  }

  const alternate = alternateAuthScheme(current)
  const second = await request(alternate)
  attempts.push({ authScheme: alternate, ...second })
  const secondUsable = second.ok && !second.identityOnly
  return {
    ok: secondUsable,
    selectedAuthScheme: secondUsable ? alternate : null,
    changed: secondUsable,
    attempts
  }
}
