import type { ChannelAuthScheme, ChannelProtocol, RelayPlatformType } from './types/hub'

export interface RelayProviderPreset {
  id: string
  name: string
  category: 'official' | 'cn_official' | 'third_party' | 'aggregator'
  homepageUrl: string
  baseUrl: string
  platformType: RelayPlatformType
  protocols: Array<{ protocol: ChannelProtocol; authScheme: ChannelAuthScheme; baseUrlOverride?: string }>
}

export const relayProviderPresets: RelayProviderPreset[] = [
  { id: 'anthropic', name: 'Anthropic Official', category: 'official', homepageUrl: 'https://console.anthropic.com', baseUrl: 'https://api.anthropic.com', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }] },
  { id: 'openai', name: 'OpenAI Official', category: 'official', homepageUrl: 'https://platform.openai.com', baseUrl: 'https://api.openai.com', platformType: 'generic', protocols: [{ protocol: 'openai_responses', authScheme: 'bearer' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'agentrouter', name: 'AgentRouter', category: 'aggregator', homepageUrl: 'https://agentrouter.org', baseUrl: 'https://agentrouter.org', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_responses', authScheme: 'bearer' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'kimi', name: 'Kimi', category: 'cn_official', homepageUrl: 'https://platform.kimi.com', baseUrl: 'https://api.moonshot.cn', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key', baseUrlOverride: 'https://api.moonshot.cn/anthropic' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'kimi-coding', name: 'Kimi For Coding', category: 'cn_official', homepageUrl: 'https://www.kimi.com/code', baseUrl: 'https://api.kimi.com/coding', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'deepseek', name: 'DeepSeek', category: 'cn_official', homepageUrl: 'https://platform.deepseek.com', baseUrl: 'https://api.deepseek.com', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key', baseUrlOverride: 'https://api.deepseek.com/anthropic' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'zhipu', name: 'Zhipu GLM', category: 'cn_official', homepageUrl: 'https://open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key', baseUrlOverride: 'https://open.bigmodel.cn/api/anthropic' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'openrouter', name: 'OpenRouter', category: 'aggregator', homepageUrl: 'https://openrouter.ai', baseUrl: 'https://openrouter.ai/api', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'packycode', name: 'PackyCode', category: 'third_party', homepageUrl: 'https://www.packyapi.ai', baseUrl: 'https://www.packyapi.ai', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_responses', authScheme: 'bearer' }] },
  { id: 'zetaapi', name: 'ZetaAPI', category: 'aggregator', homepageUrl: 'https://zetaapi.ai', baseUrl: 'https://api.zetaapi.ai', platformType: 'generic', protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_responses', authScheme: 'bearer' }] }
]
