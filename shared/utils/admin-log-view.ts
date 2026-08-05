export interface LogImagePreview {
  src: string
  label: string
}

export interface ParsedLogBody {
  parsed: boolean
  value?: unknown
}

export interface ReconstructedLogMessage {
  id: string
  label: string
  content: string
  parts: number
}

const IMAGE_BASE64_KEYS = new Set(['b64_json', 'image_base64', 'imagebase64', 'base64'])
const IMAGE_URL_KEYS = new Set(['url', 'image_url', 'imageurl'])

function compactNumber(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

export function base64ByteLength(value: string) {
  const content = value.replace(/^data:[^,]+,/, '').replace(/\s/g, '')
  if (!content) return 0
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(content.length * 3 / 4) - padding)
}

export function formatByteSize(value: number) {
  if (value >= 1024 * 1024) return `${compactNumber(value / 1024 / 1024)} MB`
  if (value >= 1024) return `${compactNumber(value / 1024)} KB`
  return `${value} B`
}

export function isImageBase64Key(key: string | number | undefined) {
  return typeof key === 'string' && IMAGE_BASE64_KEYS.has(key.toLowerCase())
}

function parseJsonValue(content: string) {
  let value: unknown = JSON.parse(content.replace(/^\uFEFF/, ''))
  if (typeof value === 'string' && /^[\s\r\n]*[\[{]/.test(value)) value = JSON.parse(value)
  return value
}

export function parseLogBodyContent(content: string, contentType = ''): ParsedLogBody {
  try {
    return { parsed: true, value: parseJsonValue(content) }
  } catch {
    // Streaming APIs store a sequence of SSE data frames rather than one JSON document.
  }

  if (/event-stream/i.test(contentType) || /^\s*(?:event:|data:)/m.test(content)) {
    const events = content.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^data:\s?(.*)$/)
      if (!match || !match[1] || match[1] === '[DONE]') return []
      try { return [parseJsonValue(match[1])] } catch { return [match[1]] }
    })
    if (events.length) return { parsed: true, value: events }
  }

  if (/ndjson|jsonl/i.test(contentType)) {
    const lines = content.split(/\r?\n/).filter(Boolean)
    try { return { parsed: true, value: lines.map(line => parseJsonValue(line)) } } catch { /* keep as text */ }
  }

  return { parsed: false }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    const item = record(part)
    return typeof item?.text === 'string' ? item.text : typeof item?.content === 'string' ? item.content : ''
  }).join('')
}

function roleLabel(role: unknown) {
  if (role === 'system') return '系统消息'
  if (role === 'developer') return '开发者消息'
  if (role === 'assistant') return '助手消息'
  if (role === 'tool') return '工具结果'
  return '用户消息'
}

export function reconstructLogRequestMessages(value: unknown): ReconstructedLogMessage[] {
  const payload = record(value)
  if (!payload) return []
  const messages: ReconstructedLogMessage[] = []
  const add = (label: string, content: unknown) => {
    const text = textContent(content)
    if (text) messages.push({ id: `request-${messages.length}`, label, content: text, parts: Array.isArray(content) ? content.length : 1 })
  }

  add('开发者指令', payload.instructions)
  if (Array.isArray(payload.messages)) {
    for (const rawMessage of payload.messages) {
      const message = record(rawMessage)
      if (message) add(roleLabel(message.role), message.content)
    }
  }

  if (typeof payload.input === 'string') {
    add('用户消息', payload.input)
  } else if (Array.isArray(payload.input)) {
    for (const rawItem of payload.input) {
      if (typeof rawItem === 'string') {
        add('用户消息', rawItem)
        continue
      }
      const item = record(rawItem)
      if (!item) continue
      if (item.type === 'function_call_output') add(`工具结果 · ${String(item.call_id || 'function')}`, item.output)
      else add(roleLabel(item.role), item.content)
    }
  }
  if (!messages.length) add('用户消息', payload.prompt)
  const rank = (label: string) => label.startsWith('用户') ? 0 : label.startsWith('工具') ? 1 : /系统|开发者/.test(label) ? 2 : 0
  return messages.map((message, index) => ({ message, index })).sort((left, right) => rank(left.message.label) - rank(right.message.label) || left.index - right.index).map(item => item.message)
}

export function reconstructLogMessages(value: unknown): ReconstructedLogMessage[] {
  const messages = new Map<string, ReconstructedLogMessage>()
  const append = (id: string, label: string, content: unknown) => {
    if (typeof content !== 'string' || !content) return
    const existing = messages.get(id)
    if (existing) {
      existing.content += content
      existing.parts += 1
    } else {
      messages.set(id, { id, label, content, parts: 1 })
    }
  }

  const events = Array.isArray(value) ? value : [value]
  for (const rawEvent of events) {
    const event = record(rawEvent)
    if (!event) continue
    const type = typeof event.type === 'string' ? event.type : ''
    const outputIndex = Number.isInteger(event.output_index) ? Number(event.output_index) : 0
    const contentIndex = Number.isInteger(event.content_index) ? Number(event.content_index) : 0
    if (type === 'response.output_text.delta') append(`response-${outputIndex}-${contentIndex}`, '助手消息', event.delta)
    if (type === 'response.refusal.delta') append(`refusal-${outputIndex}-${contentIndex}`, '拒绝消息', event.delta)
    if (type === 'response.function_call_arguments.delta') {
      const callId = typeof event.item_id === 'string' ? event.item_id : String(outputIndex)
      append(`function-${callId}`, `工具调用参数 · ${callId}`, event.delta)
    }
    if (type === 'content_block_delta') {
      const delta = record(event.delta)
      append(`content-${event.index ?? 0}`, '助手消息', delta?.text)
    }
    if (Array.isArray(event.choices)) {
      for (const rawChoice of event.choices) {
        const choice = record(rawChoice)
        const delta = record(choice?.delta)
        const index = Number.isInteger(choice?.index) ? Number(choice?.index) : 0
        append(`chat-${index}`, '助手消息', textContent(delta?.content))
      }
    }
  }
  if (messages.size) return [...messages.values()]

  const addComplete = (content: string, label = '助手消息') => {
    if (!content || [...messages.values()].some(item => item.content === content)) return
    messages.set(`complete-${messages.size}`, { id: `complete-${messages.size}`, label, content, parts: 1 })
  }
  const visitComplete = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visitComplete)
      return
    }
    const item = record(current)
    if (!item) return
    const type = typeof item.type === 'string' ? item.type : ''
    if (typeof item.output_text === 'string') addComplete(item.output_text)
    if (type === 'response.output_text.done' && typeof item.text === 'string') addComplete(item.text)
    if (type === 'response.content_part.done') visitComplete(item.part)
    if (type === 'response.output_item.done') visitComplete(item.item)
    if (type === 'message' && item.role === 'assistant') addComplete(textContent(item.content))
    if (Array.isArray(item.choices)) {
      for (const rawChoice of item.choices) {
        const choice = record(rawChoice)
        const message = record(choice?.message)
        addComplete(textContent(message?.content))
      }
    }
    if (Array.isArray(item.output)) {
      for (const rawOutput of item.output) {
        const output = record(rawOutput)
        if (!output) continue
        if (output.type === 'message') addComplete(textContent(output.content))
        if (output.type === 'function_call' && typeof output.arguments === 'string') {
          addComplete(output.arguments, `工具调用参数 · ${String(output.name || output.call_id || 'function')}`)
        }
      }
    }
    const error = record(item.error)
    if (typeof error?.message === 'string') addComplete(error.message, '错误消息')
    if (item.response) visitComplete(item.response)
  }
  visitComplete(value)
  return [...messages.values()]
}

function imageMimeFromBase64(value: string) {
  if (value.startsWith('iVBORw0KGgo')) return 'image/png'
  if (value.startsWith('/9j/')) return 'image/jpeg'
  if (value.startsWith('R0lGOD')) return 'image/gif'
  if (value.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

function looksLikeImageUrl(value: string) {
  return /^https?:\/\//i.test(value) && /(?:\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)|\/images?\/|image)/i.test(value)
}

export function extractLogImages(value: unknown): LogImagePreview[] {
  const images: LogImagePreview[] = []
  const seen = new Set<string>()

  function add(src: string, label: string) {
    if (!seen.has(src)) {
      seen.add(src)
      images.push({ src, label })
    }
  }

  function visit(current: unknown, key?: string | number, path = 'response') {
    if (typeof current === 'string') {
      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(current)) {
        add(current, String(key ?? `图片 ${images.length + 1}`))
      } else if (isImageBase64Key(key) && current.length >= 16) {
        add(`data:${imageMimeFromBase64(current)};base64,${current}`, String(key))
      } else if ((typeof key === 'string' && IMAGE_URL_KEYS.has(key.toLowerCase()) && /(?:data|image|output)/i.test(path)) || looksLikeImageUrl(current)) {
        if (/^https?:\/\//i.test(current)) add(current, String(key ?? `图片 ${images.length + 1}`))
      }
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, index, `${path}[${index}]`))
      return
    }
    if (current && typeof current === 'object') {
      for (const [childKey, child] of Object.entries(current)) visit(child, childKey, `${path}.${childKey}`)
    }
  }

  visit(value)
  return images
}
