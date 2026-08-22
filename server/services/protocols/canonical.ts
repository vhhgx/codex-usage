export type CanonicalProtocol = 'anthropic_messages' | 'openai_responses' | 'openai_chat'

export interface CanonicalUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  totalTokens: number
}

export const emptyCanonicalUsage = (): CanonicalUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0
})

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function nonnegative(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}
