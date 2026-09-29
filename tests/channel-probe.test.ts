import { describe, expect, it } from 'vitest'
import { classifyProbeResponse } from '../server/services/channel-probe-task'

const chat = (model = 'gpt-4o') => JSON.stringify({ id: 'x', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }] })
const responses = () => JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', output: [] })
const anthropic = () => JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] })

describe('classifyProbeResponse', () => {
  it('把符合协议结构的 2xx 判为可用', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 200, body: chat() })).toBe('supported')
    expect(classifyProbeResponse({ protocol: 'openai_responses', status: 200, body: responses() })).toBe('supported')
    expect(classifyProbeResponse({ protocol: 'anthropic_messages', status: 200, body: anthropic() })).toBe('supported')
  })

  it('2xx 但不是该协议结构（HTML 登录页）判为不兼容，而不是可用', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 200, body: '<!DOCTYPE html><html><body>login</body></html>' })).toBe('incompatible')
  })

  it('需要客户端身份时判为 client_identity_required', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 200, body: '{"error":"unauthorized client"}' })).toBe('client_identity_required')
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 403, body: 'client detected without coding agent client' })).toBe('client_identity_required')
  })

  it('401/403 判为凭据问题', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 401, body: '{"error":{"message":"invalid api key"}}' })).toBe('credential_error')
    expect(classifyProbeResponse({ protocol: 'anthropic_messages', status: 403, body: 'forbidden' })).toBe('credential_error')
  })

  it('404 区分「端点不存在」与「模型不存在」', () => {
    expect(classifyProbeResponse({ protocol: 'openai_responses', status: 404, body: '{"error":{"message":"The model gpt-5 does not exist"}}' })).toBe('model_missing')
    expect(classifyProbeResponse({ protocol: 'openai_responses', status: 404, body: '{"error":{"message":"unknown endpoint /v1/responses"}}' })).toBe('unsupported_endpoint')
    expect(classifyProbeResponse({ protocol: 'openai_responses', status: 404, body: '<!DOCTYPE html><html>404</html>' })).toBe('unsupported_endpoint')
  })

  it('405/501 判为协议不支持', () => {
    expect(classifyProbeResponse({ protocol: 'openai_responses', status: 405, body: 'method not allowed' })).toBe('unsupported_endpoint')
    expect(classifyProbeResponse({ protocol: 'anthropic_messages', status: 501, body: 'not implemented' })).toBe('unsupported_endpoint')
  })

  it('429 视为端点可用（被限流），不应判为失败', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 429, body: '{"error":{"message":"rate limit exceeded"}}' })).toBe('rate_limited')
  })

  it('参数级 4xx 视为端点存在（协议可用）', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 400, body: '{"error":{"message":"max_tokens must be >= 1"}}' })).toBe('supported')
    expect(classifyProbeResponse({ protocol: 'openai_responses', status: 422, body: '{"error":{"message":"invalid value for input"}}' })).toBe('supported')
  })

  it('4xx 若明确指向上游端点不存在则判为不支持', () => {
    expect(classifyProbeResponse({ protocol: 'anthropic_messages', status: 400, body: '{"error":{"message":"unsupported endpoint"}}' })).toBe('unsupported_endpoint')
  })

  it('5xx 判为上游错误（与协议能力无关）', () => {
    expect(classifyProbeResponse({ protocol: 'openai_chat', status: 503, body: 'upstream unavailable' })).toBe('upstream_error')
  })
})
