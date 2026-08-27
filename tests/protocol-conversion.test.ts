import { describe, expect, it } from 'vitest'
import { anthropicToOpenAiChat, anthropicUsage, openAiChatToAnthropic } from '../server/services/protocols/anthropic-openai'
import { pipeOpenAiChatAsAnthropic } from '../server/services/protocols/anthropic-stream'
import { compareRouteCandidates, keyRouteSources, modelMappingAllowsRouting, orderedRouteSourceNodes } from '../server/services/hub-routing'
import { ChatToResponsesStream, chatToResponsesResponse, responsesToChatRequest } from '../server/services/protocols/responses-chat'

describe('Anthropic and OpenAI protocol conversion', () => {
  it('converts Responses instructions, tools and tool results to Chat Completions', () => {
    const result = responsesToChatRequest({ model: 'public', instructions: 'Be precise', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read it' }] }, { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' }, { type: 'function_call_output', call_id: 'call-1', output: 'ok' }], tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], reasoning: { effort: 'high' } }, 'upstream')
    expect(result).toMatchObject({ model: 'upstream', reasoning_effort: 'high', messages: [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Read it' }, { role: 'assistant' }, { role: 'tool', tool_call_id: 'call-1', content: 'ok' }] })
  })

  it('converts a Chat response and usage to a Responses response', () => {
    const result = chatToResponsesResponse({ id: 'chatcmpl-1', model: 'glm', choices: [{ message: { content: 'done', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }, 'gpt-public')
    expect(result).toMatchObject({ id: 'resp_1', model: 'gpt-public', status: 'completed', output_text: 'done', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } })
    expect(result.output).toHaveLength(2)
  })

  it('emits Responses SSE events from Chat chunks', () => {
    const converter = new ChatToResponsesStream('gpt-public')
    const output = Buffer.concat([
      converter.push(Buffer.from('data: {"id":"chatcmpl-1","model":"glm","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n')),
      converter.push(Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n'), true)
    ]).toString()
    expect(output).toContain('event: response.created')
    expect(output).toContain('event: response.output_text.delta')
    expect(output).toContain('event: response.completed')
    expect(output).toContain('"delta":"hi"')
  })
  it('maps system, tools, tool use and tool results to Chat Completions', () => {
    const result = anthropicToOpenAiChat({
      model: 'hub-model',
      system: [{ type: 'text', text: 'You are precise.' }],
      max_tokens: 128,
      tools: [{ name: 'read_file', description: 'Read one file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'Read README' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello' }] }
      ]
    }, 'upstream-model')
    expect(result).toMatchObject({ model: 'upstream-model', max_tokens: 128 })
    expect(result.messages).toEqual([
      { role: 'system', content: 'You are precise.' },
      { role: 'user', content: 'Read README' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: 'tool-1', content: 'hello' }
    ])
  })

  it('maps a non-stream response and cached usage to Anthropic', () => {
    const result = openAiChatToAnthropic({
      id: 'chat-1',
      choices: [{ finish_reason: 'tool_calls', message: { content: 'Checking', tool_calls: [{ id: 'call-1', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } }
    }, 'hub-model')
    expect(result).toMatchObject({ id: 'chat-1', model: 'hub-model', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 } })
    expect(result.content).toEqual([
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', id: 'call-1', name: 'shell', input: { cmd: 'pwd' } }
    ])
  })

  it('counts Anthropic cache reads and cache creation separately', () => {
    expect(anthropicUsage({ usage: { input_tokens: 12, cache_read_input_tokens: 80, cache_creation_input_tokens: 20, output_tokens: 8 } })).toEqual({
      inputTokens: 112,
      outputTokens: 8,
      cachedTokens: 80,
      cacheCreationTokens: 20,
      reasoningTokens: 0,
      totalTokens: 120
    })
  })

  it('orders platform and private relay routing according to the Key mode', () => {
    expect(keyRouteSources('platform_only')).toEqual(['platform'])
    expect(keyRouteSources('private_only')).toEqual(['private_pool', 'user_relay'])
    expect(keyRouteSources('platform_then_private')).toEqual(['platform', 'private_pool', 'user_relay'])
    expect(keyRouteSources('private_then_platform')).toEqual(['private_pool', 'user_relay', 'platform'])
  })

  it('filters the user failover sequence according to the Key route mode', () => {
    const order = ['relay:first', 'private_pool', 'package', 'relay:last']
    expect(orderedRouteSourceNodes('platform_then_private', order).map(item => item.id)).toEqual(order)
    expect(orderedRouteSourceNodes('platform_only', order).map(item => item.id)).toEqual(['package'])
    expect(orderedRouteSourceNodes('private_only', order).map(item => item.id)).toEqual(['relay:first', 'private_pool', 'relay:last'])
  })

  it('uses the dragged relay position before protocol conversion quality', () => {
    const convertedFirst = { channel: { priority: 10, name: 'first' }, conversionMode: 'anthropic_to_openai' as const }
    const directSecond = { channel: { priority: 20, name: 'second' }, conversionMode: 'passthrough' as const }
    expect([directSecond, convertedFirst].sort((left, right) => compareRouteCandidates(left, right, 'user_relay'))).toEqual([convertedFirst, directSecond])
    expect([convertedFirst, directSecond].sort((left, right) => compareRouteCandidates(left, right, 'platform'))).toEqual([directSecond, convertedFirst])
  })

  it('treats an explicit private relay model mapping as substitution authorization', () => {
    expect(modelMappingAllowsRouting('substitution', 'user_relay')).toBe(true)
    expect(modelMappingAllowsRouting('substitution', 'platform')).toBe(false)
    expect(modelMappingAllowsRouting('substitution', 'platform', true)).toBe(true)
    expect(modelMappingAllowsRouting('identity', 'platform')).toBe(true)
  })

  it('produces valid Anthropic SSE across arbitrary input chunks', async () => {
    const source = [
      'data: {"id":"chat-1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"shell","arguments":"{\\"cmd\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const bytes = new TextEncoder().encode(source)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7))
        controller.close()
      }
    })
    const chunks: Uint8Array[] = []
    const usage = await pipeOpenAiChatAsAnthropic(stream, 'hub-model', async chunk => { chunks.push(chunk) })
    const output = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
    expect(output).toContain('event: message_start')
    expect(output).toContain('"type":"text_delta","text":"Hel"')
    expect(output).toContain('"type":"tool_use","id":"call-1","name":"shell"')
    expect(output).toContain('"type":"input_json_delta","partial_json":"{\\"cmd\\":"')
    expect(output.match(/event: message_stop/g)).toHaveLength(1)
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 4, totalTokens: 14 })
  })
})
