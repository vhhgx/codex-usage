import { emptyCanonicalUsage, nonnegative, record, type CanonicalUsage } from './canonical'

type Json = Record<string, unknown>

function textBlocks(value: unknown) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((block) => {
    const item = record(block)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

function imagePart(block: Json) {
  const source = record(block.source)
  if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } }
  }
  if (source?.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } }
  return null
}

export function anthropicToOpenAiChat(body: Json, upstreamModel: string) {
  const messages: Json[] = []
  const system = textBlocks(body.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(rawMessage)
    if (!message || message.role !== 'user' && message.role !== 'assistant') continue
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    const blocks = Array.isArray(message.content) ? message.content.map(record).filter((item): item is Json => Boolean(item)) : []
    const content: Json[] = blocks.flatMap((block): Json[] => {
      if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
      if (block.type === 'image') {
        const image = imagePart(block)
        return image ? [image] : []
      }
      return []
    })
    const toolCalls = blocks.flatMap((block) => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
      : [])
    const toolResults = blocks.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    if (content.length || toolCalls.length || !toolResults.length) messages.push({
      role: message.role,
      content: content.length ? content : null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    })
    for (const result of toolResults) messages.push({
      role: 'tool',
      tool_call_id: result.tool_use_id,
      content: textBlocks(result.content) || (typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? ''))
    })
  }
  const tools = Array.isArray(body.tools) ? body.tools.flatMap((raw) => {
    const tool = record(raw)
    return tool && typeof tool.name === 'string' ? [{ type: 'function', function: { name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, parameters: tool.input_schema || {} } }] : []
  }) : undefined
  const choice = record(body.tool_choice)
  let toolChoice: unknown
  if (choice?.type === 'auto') toolChoice = 'auto'
  else if (choice?.type === 'any') toolChoice = 'required'
  else if (choice?.type === 'none') toolChoice = 'none'
  else if (choice?.type === 'tool' && typeof choice.name === 'string') toolChoice = { type: 'function', function: { name: choice.name } }
  return {
    model: upstreamModel,
    messages,
    stream: body.stream === true,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(Number.isFinite(Number(body.max_tokens)) ? { max_tokens: Number(body.max_tokens) } : {}),
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Number.isFinite(Number(body.top_p)) ? { top_p: Number(body.top_p) } : {}),
    ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences } : {})
  }
}

function stopReason(value: unknown) {
  if (value === 'length') return 'max_tokens'
  if (value === 'tool_calls') return 'tool_use'
  if (value === 'content_filter') return 'refusal'
  return 'end_turn'
}

export function openAiUsage(value: unknown): CanonicalUsage {
  const usage = record(value)
  if (!usage) return emptyCanonicalUsage()
  const input = nonnegative(usage.prompt_tokens ?? usage.input_tokens)
  const output = nonnegative(usage.completion_tokens ?? usage.output_tokens)
  const inputDetails = record(usage.prompt_tokens_details) || record(usage.input_tokens_details)
  const outputDetails = record(usage.completion_tokens_details) || record(usage.output_tokens_details)
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: nonnegative(inputDetails?.cached_tokens),
    cacheCreationTokens: 0,
    reasoningTokens: nonnegative(outputDetails?.reasoning_tokens),
    totalTokens: nonnegative(usage.total_tokens) || input + output
  }
}

export function openAiChatToAnthropic(payload: Json, requestedModel: string) {
  const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : null)
  const message = record(choice?.message)
  const content = []
  if (typeof message?.content === 'string' && message.content) content.push({ type: 'text', text: message.content })
  if (Array.isArray(message?.tool_calls)) {
    for (const raw of message.tool_calls) {
      const tool = record(raw)
      const fn = record(tool?.function)
      if (!tool || !fn || typeof tool.id !== 'string' || typeof fn.name !== 'string') continue
      let input: unknown = {}
      try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {} } catch { input = { _raw: fn.arguments } }
      content.push({ type: 'tool_use', id: tool.id, name: fn.name, input } as never)
    }
  }
  const usage = openAiUsage(payload.usage)
  return {
    type: 'message',
    id: typeof payload.id === 'string' ? payload.id : `msg_${crypto.randomUUID().replace(/-/g, '')}`,
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cachedTokens,
      cache_creation_input_tokens: usage.cacheCreationTokens
    }
  }
}

export function anthropicUsage(value: unknown): CanonicalUsage {
  const payload = record(value)
  const usage = record(payload?.usage) || record(record(payload?.message)?.usage) || payload
  if (!usage) return emptyCanonicalUsage()
  const input = nonnegative(usage.input_tokens)
  const output = nonnegative(usage.output_tokens)
  const cached = nonnegative(usage.cache_read_input_tokens)
  const created = nonnegative(usage.cache_creation_input_tokens)
  return { inputTokens: input + cached + created, outputTokens: output, cachedTokens: cached, cacheCreationTokens: created, reasoningTokens: 0, totalTokens: input + cached + created + output }
}

export { stopReason as openAiStopReason }
