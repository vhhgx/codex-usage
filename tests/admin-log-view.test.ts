import { describe, expect, it } from 'vitest'
import { base64ByteLength, extractLogImages, parseLogBodyContent, reconstructLogMessages, reconstructLogRequestMessages } from '../shared/utils/admin-log-view'
import { formatTokenCount } from '../shared/utils/number-format'
import { requestModelMapping, requestReasoningEffort } from '../shared/utils/request-log'

describe('admin request log presentation', () => {
  it('shows only effective model mappings and reads both reasoning formats', () => {
    expect(requestModelMapping('gpt-5.6-sol', 'glm-5.3-flash')).toBe('gpt-5.6-sol → glm-5.3-flash')
    expect(requestModelMapping('gpt-5.6-sol', 'gpt-5.6-sol')).toBeNull()
    expect(requestModelMapping('gpt-5.6-sol', null)).toBeNull()
    expect(requestReasoningEffort({ reasoning: { effort: 'high' } })).toBe('high')
    expect(requestReasoningEffort({ reasoning_effort: 'xhigh' })).toBe('xhigh')
  })

  it('keeps token counts through 1M explicit, then uses M and B units', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(520_000)).toBe('520,000')
    expect(formatTokenCount(1_000_000)).toBe('1,000,000')
    expect(formatTokenCount(1_250_000)).toBe('1.25M')
    expect(formatTokenCount(12_400_000)).toBe('12.4M')
    expect(formatTokenCount(999_900_000)).toBe('999.9M')
    expect(formatTokenCount(1_000_000_000)).toBe('1B')
    expect(formatTokenCount(1_250_000_000)).toBe('1.25B')
  })

  it('extracts OpenAI base64, data URL, and image URL responses', () => {
    const result = extractLogImages({
      data: [
        { b64_json: 'iVBORw0KGgoAAAABBBBCCCCDDDDEEEE' },
        { url: 'https://cdn.example.com/generated/output.png' },
        { image_url: 'data:image/webp;base64,UklGRiIAAABXRUJQ' }
      ]
    })
    expect(result).toHaveLength(3)
    expect(result[0]?.src).toMatch(/^data:image\/png;base64,/)
    expect(result[1]?.src).toBe('https://cdn.example.com/generated/output.png')
    expect(result[2]?.src).toBe('data:image/webp;base64,UklGRiIAAABXRUJQ')
  })

  it('calculates padded base64 sizes', () => {
    expect(base64ByteLength('YQ==')).toBe(1)
    expect(base64ByteLength('data:image/png;base64,YWI=')).toBe(2)
  })

  it('parses double-encoded JSON and streaming SSE frames', () => {
    expect(parseLogBodyContent(JSON.stringify('{"model":"gpt-5"}'), 'application/json')).toEqual({
      parsed: true,
      value: { model: 'gpt-5' }
    })
    expect(parseLogBodyContent('data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n', 'text/event-stream')).toEqual({
      parsed: true,
      value: [{ type: 'response.created' }, { type: 'response.completed' }]
    })
  })

  it('reconstructs Responses API text and tool argument deltas', () => {
    expect(reconstructLogMessages([
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello ' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'world' },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '"app.vue"}' }
    ])).toEqual([
      { id: 'response-0-0', label: '助手消息', content: 'hello world', parts: 2 },
      { id: 'function-call_1', label: '工具调用参数 · call_1', content: '{"path":"app.vue"}', parts: 2 }
    ])
  })

  it('reconstructs streaming and non-streaming chat messages', () => {
    expect(reconstructLogMessages([
      { choices: [{ index: 0, delta: { content: 'line 1\n' } }] },
      { choices: [{ index: 0, delta: { content: '```ts\nconst ok = true\n```' } }] }
    ])[0]?.content).toBe('line 1\n```ts\nconst ok = true\n```')
    expect(reconstructLogMessages({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'complete response' }] }]
    })[0]?.content).toBe('complete response')
  })

  it('organizes Responses and Chat request messages in role order', () => {
    expect(reconstructLogRequestMessages({
      instructions: 'Follow the repository conventions.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Change the button.' }, { type: 'input_image', image_url: 'data:image/png;base64,hidden' }] },
        { type: 'function_call_output', call_id: 'call_1', output: 'file contents' }
      ]
    })).toEqual([
      { id: 'request-1', label: '用户消息', content: 'Change the button.', parts: 2 },
      { id: 'request-2', label: '工具结果 · call_1', content: 'file contents', parts: 1 },
      { id: 'request-0', label: '开发者指令', content: 'Follow the repository conventions.', parts: 1 }
    ])
    expect(reconstructLogRequestMessages({
      messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hello' }]
    }).map(item => item.label)).toEqual(['用户消息', '系统消息'])
  })

  it('extracts completed-only response events and error messages', () => {
    expect(reconstructLogMessages([
      { type: 'response.output_text.done', text: 'final text' }
    ])[0]?.content).toBe('final text')
    expect(reconstructLogMessages([
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'item text' }] } }
    ])[0]?.content).toBe('item text')
    expect(reconstructLogMessages({ error: { message: 'upstream failed' } })[0]).toMatchObject({
      label: '错误消息',
      content: 'upstream failed'
    })
  })
})
