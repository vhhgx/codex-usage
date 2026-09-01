import { createError } from 'h3'
import { record } from './canonical'
import { openAiUsage } from './anthropic-openai'

type Json = Record<string, unknown>

export function responsesRequestNeedsChatCompatibility(body: Json | null | undefined) {
  if (!body) return false
  if (body.client_metadata !== undefined) return true
  return Array.isArray(body.input) && body.input.some((raw) => {
    const item = record(raw)
    return item?.type === 'additional_tools'
  })
}

function contentText(value: unknown) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((raw) => {
    const item = record(raw)
    return item && (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

function responseTool(tool: Json) {
  if (tool.type === 'function' && typeof tool.name === 'string') return {
    type: 'function',
    function: { name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, parameters: record(tool.parameters) || {} }
  }
  if (tool.type === 'custom' && typeof tool.name === 'string') return {
    type: 'function',
    function: {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : 'Accept the original custom tool input unchanged.',
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
    }
  }
  throw createError({ statusCode: 422, message: `Responses 工具 ${String(tool.type || 'unknown')} 无法可靠转换为 Chat Completions` })
}

export function responsesToChatRequest(body: Json, upstreamModel: string) {
  const messages: Json[] = []
  const instructions = contentText(body.instructions)
  if (instructions) messages.push({ role: 'system', content: instructions })
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : []
  for (const raw of input) {
    const item = record(raw)
    if (!item) continue
    if (item.type === 'function_call' && typeof item.name === 'string') {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: typeof item.call_id === 'string' ? item.call_id : crypto.randomUUID(), type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) } }] })
      continue
    }
    if (item.type === 'function_call_output' && typeof item.call_id === 'string') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') })
      continue
    }
    if (item.type === 'message' || item.role === 'user' || item.role === 'assistant' || item.role === 'system' || item.role === 'developer') {
      const role = item.role === 'developer' ? 'system' : item.role === 'assistant' || item.role === 'system' ? item.role : 'user'
      const content = contentText(item.content)
      if (content) messages.push({ role, content })
    }
  }
  if (!messages.length) throw createError({ statusCode: 422, message: 'Responses 请求没有可转换的文本或工具上下文' })
  const tools = Array.isArray(body.tools) ? body.tools.map(record).filter((item): item is Json => Boolean(item)).map(responseTool) : []
  const reasoning = record(body.reasoning)
  const result: Json = {
    model: upstreamModel,
    messages,
    stream: body.stream === true,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(Number.isFinite(Number(body.max_output_tokens)) ? { max_tokens: Number(body.max_output_tokens) } : {}),
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Number.isFinite(Number(body.top_p)) ? { top_p: Number(body.top_p) } : {}),
    ...(typeof reasoning?.effort === 'string' ? { reasoning_effort: reasoning.effort } : {})
  }
  if (body.stream === true) result.stream_options = { include_usage: true }
  return result
}

function responseId(value: unknown) {
  const raw = typeof value === 'string' ? value.replace(/^chatcmpl-/, '') : crypto.randomUUID().replace(/-/g, '')
  return `resp_${raw}`
}

function parseArguments(value: unknown) {
  if (typeof value !== 'string') return '{}'
  try { return JSON.stringify(JSON.parse(value)) } catch { return value }
}

export function chatToResponsesResponse(payload: Json, requestedModel: string) {
  const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : null)
  const message = record(choice?.message)
  const id = responseId(payload.id)
  const output: Json[] = []
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : typeof message?.reasoning === 'string' ? message.reasoning : ''
  if (reasoning) output.push({ id: `rs_${id}`, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] })
  const text = contentText(message?.content)
  if (text) output.push({ id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text }] })
  for (const raw of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    const tool = record(raw)
    const fn = record(tool?.function)
    if (!fn || typeof fn.name !== 'string') continue
    output.push({ id: typeof tool?.id === 'string' ? tool.id : `fc_${crypto.randomUUID().replace(/-/g, '')}`, type: 'function_call', status: 'completed', call_id: typeof tool?.id === 'string' ? tool.id : crypto.randomUUID(), name: fn.name, arguments: parseArguments(fn.arguments) })
  }
  const usage = openAiUsage(payload.usage)
  return {
    id,
    object: 'response',
    created_at: typeof payload.created === 'number' ? payload.created : Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestedModel,
    output,
    output_text: text,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, input_tokens_details: { cached_tokens: usage.cachedTokens }, output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
  }
}

function sse(type: string, data: Json) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

interface StreamTool { id: string; callId: string; name: string; arguments: string; added: boolean }

export class ChatToResponsesStream {
  private pending = ''
  private started = false
  private completed = false
  private id = `resp_${crypto.randomUUID().replace(/-/g, '')}`
  private model: string
  private text = ''
  private textAdded = false
  private reasoning = ''
  private reasoningAdded = false
  private usage: Json | null = null
  private tools = new Map<number, StreamTool>()

  constructor(requestedModel: string) { this.model = requestedModel }

  push(chunk: Buffer, final = false) {
    this.pending += chunk.toString('utf8').replace(/\r\n/g, '\n')
    const output: string[] = []
    let boundary: number
    while ((boundary = this.pending.indexOf('\n\n')) >= 0) {
      const block = this.pending.slice(0, boundary)
      this.pending = this.pending.slice(boundary + 2)
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      if (data === '[DONE]') { output.push(...this.finish()); continue }
      try { output.push(...this.handle(JSON.parse(data))) } catch { /* Ignore comments and malformed vendor frames. */ }
    }
    if (final && !this.completed) output.push(...this.finish())
    return Buffer.from(output.join(''))
  }

  private base(status = 'in_progress') {
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.model, output: [] }
  }

  private ensureStarted() {
    if (this.started) return []
    this.started = true
    return [sse('response.created', { response: this.base() }), sse('response.in_progress', { response: this.base() })]
  }

  private handle(payload: Json) {
    if (typeof payload.id === 'string') this.id = responseId(payload.id)
    if (typeof payload.model === 'string') this.model = payload.model
    const output = this.ensureStarted()
    if (payload.usage && typeof payload.usage === 'object') this.usage = payload.usage as Json
    const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : null)
    const delta = record(choice?.delta)
    const reasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : typeof delta?.reasoning === 'string' ? delta.reasoning : ''
    if (reasoning) {
      const itemId = `rs_${this.id}`
      if (!this.reasoningAdded) { this.reasoningAdded = true; output.push(sse('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] } }), sse('response.reasoning_summary_part.added', { item_id: itemId, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } })) }
      this.reasoning += reasoning
      output.push(sse('response.reasoning_summary_text.delta', { item_id: itemId, output_index: 0, summary_index: 0, delta: reasoning }))
    }
    if (typeof delta?.content === 'string' && delta.content) {
      const index = this.reasoningAdded ? 1 : 0
      const itemId = `msg_${this.id}`
      if (!this.textAdded) { this.textAdded = true; output.push(sse('response.output_item.added', { output_index: index, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }), sse('response.content_part.added', { item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', annotations: [], text: '' } })) }
      this.text += delta.content
      output.push(sse('response.output_text.delta', { item_id: itemId, output_index: index, content_index: 0, delta: delta.content }))
    }
    for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      const call = record(raw)
      const index = Number(call?.index || 0)
      const fn = record(call?.function)
      const existing = this.tools.get(index) || { id: typeof call?.id === 'string' ? call.id : `fc_${crypto.randomUUID().replace(/-/g, '')}`, callId: typeof call?.id === 'string' ? call.id : crypto.randomUUID(), name: '', arguments: '', added: false }
      if (typeof call?.id === 'string') { existing.id = call.id; existing.callId = call.id }
      if (typeof fn?.name === 'string') existing.name += fn.name
      if (typeof fn?.arguments === 'string') existing.arguments += fn.arguments
      const outputIndex = (this.reasoningAdded ? 1 : 0) + (this.textAdded ? 1 : 0) + index
      if (!existing.added && existing.name) { existing.added = true; output.push(sse('response.output_item.added', { output_index: outputIndex, item: { id: existing.id, type: 'function_call', status: 'in_progress', call_id: existing.callId, name: existing.name, arguments: '' } })) }
      if (typeof fn?.arguments === 'string' && fn.arguments) output.push(sse('response.function_call_arguments.delta', { item_id: existing.id, output_index: outputIndex, delta: fn.arguments }))
      this.tools.set(index, existing)
    }
    return output
  }

  private finish() {
    if (this.completed) return []
    this.completed = true
    const output: string[] = []
    let index = 0
    if (this.reasoningAdded) { const item = { id: `rs_${this.id}`, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: this.reasoning }] }; output.push(sse('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: this.reasoning }), sse('response.output_item.done', { output_index: index++, item })) }
    if (this.textAdded) { const item = { id: `msg_${this.id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: this.text }] }; output.push(sse('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: this.text }), sse('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] as Json }), sse('response.output_item.done', { output_index: index++, item })) }
    for (const tool of this.tools.values()) { const item = { id: tool.id, type: 'function_call', status: 'completed', call_id: tool.callId, name: tool.name, arguments: tool.arguments }; output.push(sse('response.function_call_arguments.done', { item_id: tool.id, output_index: index, arguments: tool.arguments }), sse('response.output_item.done', { output_index: index++, item })) }
    const usage = openAiUsage(this.usage)
    const response = { ...this.base('completed'), output: [], usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, input_tokens_details: { cached_tokens: usage.cachedTokens }, output_tokens_details: { reasoning_tokens: usage.reasoningTokens } } }
    output.push(sse('response.completed', { response }), 'data: [DONE]\n\n')
    return output
  }
}
