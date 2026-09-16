import type { ChannelProtocol } from '../types/hub'

// 每个模型家族的协议偏好（按优先级排序）
const PROTOCOL_PREFERENCES = {
  claude: ['anthropic_messages', 'openai_chat'] as const,
  gpt: ['openai_responses', 'openai_chat'] as const,
  gemini: ['openai_responses', 'openai_chat'] as const,
  other: ['openai_responses', 'openai_chat'] as const,
} as const

// 判断模型家族
export function detectModelFamily(model: string): keyof typeof PROTOCOL_PREFERENCES {
  const lower = model.toLowerCase()
  if (lower.includes('claude')) return 'claude'
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'gpt'
  if (lower.includes('gemini')) return 'gemini'
  return 'other'
}

// 获取模型的协议偏好列表
export function getProtocolPreferences(model: string): readonly ChannelProtocol[] {
  return PROTOCOL_PREFERENCES[detectModelFamily(model)]
}

// 计算协议匹配分数（分数越高越优先）
export function protocolMatchScore(
  requestedProtocol: ChannelProtocol,
  channelProtocol: ChannelProtocol,
  model: string
): number {
  // 完全匹配：最高分
  if (requestedProtocol === channelProtocol) return 1000

  const preferences = getProtocolPreferences(model)
  const channelRank = preferences.indexOf(channelProtocol)

  // 渠道协议不在偏好列表中：不可用
  if (channelRank === -1) return -1

  // 渠道协议在偏好列表中：根据排名计分
  // 偏好度分数：100 - 排名*10
  const preferenceScore = 100 - channelRank * 10

  // 需要转换：扣分
  const conversionPenalty = canConvert(requestedProtocol, channelProtocol) ? -10 : -1000

  return preferenceScore + conversionPenalty
}

// 判断是否可以转换
export function canConvert(
  from: ChannelProtocol,
  to: ChannelProtocol
): boolean {
  const conversions: Record<ChannelProtocol, ChannelProtocol[]> = {
    anthropic_messages: ['openai_chat'],
    openai_responses: ['openai_chat'],
    openai_chat: ['anthropic_messages'], // 支持反向转换
  }
  return conversions[from]?.includes(to) ?? false
}

// 获取转换模式
export function getConversionMode(
  from: ChannelProtocol,
  to: ChannelProtocol
): 'passthrough' | 'anthropic_to_openai' | 'openai_to_anthropic' | 'responses_to_chat' {
  if (from === to) return 'passthrough'
  if (from === 'anthropic_messages' && to === 'openai_chat') return 'anthropic_to_openai'
  if (from === 'openai_chat' && to === 'anthropic_messages') return 'openai_to_anthropic'
  if (from === 'openai_responses' && to === 'openai_chat') return 'responses_to_chat'
  return 'passthrough'
}
