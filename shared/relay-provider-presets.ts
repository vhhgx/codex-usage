import type { ChannelAuthScheme, ChannelProtocol, RelayCapabilityMode, RelayModelScope, RelayPlatformType } from './types/hub'

export interface RelayProviderPreset {
  id: string
  name: string
  category: 'official' | 'cn_official' | 'third_party' | 'aggregator'
  homepageUrl: string
  baseUrl: string
  platformType: RelayPlatformType
  providerFamily?: string
  productType?: 'generic' | 'api' | 'coding_plan'
  modelScopes?: RelayModelScope[]
  defaultModels?: string[]
  protocols: Array<{ protocol: ChannelProtocol; authScheme: ChannelAuthScheme; baseUrlOverride?: string }>
}

/**
 * A provider that exposes OpenAI Chat but no native Responses endpoint can
 * still serve Codex requests through the Hub's Responses-to-Chat adapter.
 * Keep this capability derived from the preset's declared protocols so a new
 * preset cannot accidentally advertise native Responses support.
 */
export function relayPresetCapabilityMode(preset: RelayProviderPreset, protocol: ChannelProtocol): RelayCapabilityMode {
  return protocol === 'openai_chat' && !preset.protocols.some(item => item.protocol === 'openai_responses')
    ? 'responses_via_chat'
    : 'native'
}

export const relayProviderPresets: RelayProviderPreset[] = [
  { id: 'anthropic', name: 'Anthropic Official', category: 'official', homepageUrl: 'https://console.anthropic.com', baseUrl: 'https://api.anthropic.com', platformType: 'generic', modelScopes: ['claude'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }] },
  { id: 'openai', name: 'OpenAI Official', category: 'official', homepageUrl: 'https://platform.openai.com', baseUrl: 'https://api.openai.com', platformType: 'generic', modelScopes: ['gpt'], protocols: [{ protocol: 'openai_responses', authScheme: 'bearer' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'agentrouter', name: 'AgentRouter', category: 'aggregator', homepageUrl: 'https://agentrouter.org', baseUrl: 'https://agentrouter.org', platformType: 'generic', modelScopes: ['gpt', 'claude', 'other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_responses', authScheme: 'bearer' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'kimi', name: 'Kimi', category: 'cn_official', homepageUrl: 'https://platform.kimi.com', baseUrl: 'https://api.moonshot.cn', platformType: 'generic', modelScopes: ['other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key', baseUrlOverride: 'https://api.moonshot.cn/anthropic' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'kimi-coding', name: 'Kimi For Coding', category: 'cn_official', homepageUrl: 'https://www.kimi.com/code', baseUrl: 'https://api.kimi.com/coding', platformType: 'generic', modelScopes: ['other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'deepseek', name: 'DeepSeek', category: 'cn_official', homepageUrl: 'https://platform.deepseek.com', baseUrl: 'https://api.deepseek.com', platformType: 'generic', modelScopes: ['other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key', baseUrlOverride: 'https://api.deepseek.com/anthropic' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'zhipu-responses', name: 'Zhipu GLM Responses', category: 'cn_official', homepageUrl: 'https://open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/v1', platformType: 'generic', providerFamily: 'zhipu', productType: 'coding_plan', modelScopes: ['other'], defaultModels: ['glm-5.3', 'glm-5.3-flash'], protocols: [{ protocol: 'openai_responses', authScheme: 'bearer' }] },
  { id: 'zhipu', name: 'Zhipu GLM API Chat', category: 'cn_official', homepageUrl: 'https://open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', platformType: 'generic', providerFamily: 'zhipu', productType: 'api', modelScopes: ['other'], defaultModels: ['glm-5.3', 'glm-5.3-flash'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key', baseUrlOverride: 'https://open.bigmodel.cn/api/anthropic' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'zhipu-coding-chat', name: 'Zhipu GLM Coding Plan Chat', category: 'cn_official', homepageUrl: 'https://open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', platformType: 'generic', providerFamily: 'zhipu', productType: 'coding_plan', modelScopes: ['other'], defaultModels: ['glm-5.3', 'glm-5.3-flash'], protocols: [{ protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'doubao-responses', name: 'Doubao Seed Responses', category: 'cn_official', homepageUrl: 'https://console.volcengine.com/ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', platformType: 'generic', providerFamily: 'doubao', productType: 'api', modelScopes: ['other'], defaultModels: ['doubao-seed-2-1-pro-260628'], protocols: [{ protocol: 'openai_responses', authScheme: 'bearer' }] },
  { id: 'minimax-responses', name: 'MiniMax Responses', category: 'cn_official', homepageUrl: 'https://platform.minimaxi.com', baseUrl: 'https://api.minimaxi.com/v1', platformType: 'generic', providerFamily: 'minimax', productType: 'coding_plan', modelScopes: ['other'], defaultModels: ['MiniMax-M3'], protocols: [{ protocol: 'openai_responses', authScheme: 'bearer' }] },
  { id: 'openrouter', name: 'OpenRouter', category: 'aggregator', homepageUrl: 'https://openrouter.ai', baseUrl: 'https://openrouter.ai/api', platformType: 'generic', modelScopes: ['gpt', 'claude', 'other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_chat', authScheme: 'bearer' }] },
  { id: 'packycode', name: 'PackyCode', category: 'third_party', homepageUrl: 'https://www.packyapi.ai', baseUrl: 'https://www.packyapi.ai', platformType: 'generic', modelScopes: ['gpt', 'claude', 'other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_responses', authScheme: 'bearer' }] },
  { id: 'zetaapi', name: 'ZetaAPI', category: 'aggregator', homepageUrl: 'https://zetaapi.ai', baseUrl: 'https://api.zetaapi.ai', platformType: 'generic', modelScopes: ['gpt', 'claude', 'other'], protocols: [{ protocol: 'anthropic_messages', authScheme: 'x_api_key' }, { protocol: 'openai_responses', authScheme: 'bearer' }] }
]
