export function requestReasoningEffort(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const reasoning = body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
    ? body.reasoning as Record<string, unknown>
    : null
  const effort = typeof reasoning?.effort === 'string'
    ? reasoning.effort
    : typeof body.reasoning_effort === 'string'
      ? body.reasoning_effort
      : ''
  return effort.trim().slice(0, 40) || null
}

export function requestModelMapping(requestedModel: string | null, upstreamModel: string | null) {
  const requested = requestedModel?.trim() || ''
  const upstream = upstreamModel?.trim() || ''
  return requested && upstream && requested !== upstream ? `${requested} → ${upstream}` : null
}
