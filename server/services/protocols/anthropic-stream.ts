import { createParser } from 'eventsource-parser'
import { emptyCanonicalUsage, record, type CanonicalUsage } from './canonical'
import { openAiStopReason, openAiUsage } from './anthropic-openai'

const encoder = new TextEncoder()

function sse(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export async function pipeOpenAiChatAsAnthropic(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
  write: (chunk: Uint8Array) => Promise<void>
) {
  const decoder = new TextDecoder()
  const queued: Array<{ event?: string; data: string }> = []
  const parser = createParser({ onEvent: event => queued.push(event) })
  const reader = body.getReader()
  let messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`
  let started = false
  let textIndex: number | null = null
  let nextIndex = 0
  const tools = new Map<number, { blockIndex: number; id: string; name: string }>()
  const openBlocks = new Set<number>()
  let usage = emptyCanonicalUsage()
  let stopped = false

  const emit = async (event: string, data: unknown) => write(sse(event, data))
  const start = async () => {
    if (started) return
    started = true
    await emit('message_start', { type: 'message_start', message: { type: 'message', id: messageId, role: 'assistant', model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  }
  const closeBlocks = async () => {
    for (const index of [...openBlocks].sort((left, right) => left - right)) await emit('content_block_stop', { type: 'content_block_stop', index })
    openBlocks.clear()
  }
  const finish = async (reason: unknown) => {
    if (stopped) return
    stopped = true
    await start()
    await closeBlocks()
    await emit('message_delta', { type: 'message_delta', delta: { stop_reason: openAiStopReason(reason), stop_sequence: null }, usage: { output_tokens: usage.outputTokens } })
    await emit('message_stop', { type: 'message_stop' })
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parser.feed(decoder.decode(value, { stream: true }))
    while (queued.length) {
      const event = queued.shift()!
      if (event.data === '[DONE]') { await finish('stop'); continue }
      let payload: Record<string, unknown>
      try { payload = JSON.parse(event.data) } catch { continue }
      if (typeof payload.id === 'string') messageId = payload.id
      const parsedUsage = openAiUsage(payload.usage)
      if (parsedUsage.totalTokens) usage = parsedUsage
      const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : null)
      const delta = record(choice?.delta)
      if (delta) {
        await start()
        if (typeof delta.content === 'string' && delta.content) {
          if (textIndex === null) {
            textIndex = nextIndex++
            openBlocks.add(textIndex)
            await emit('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } })
          }
          await emit('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } })
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawTool of delta.tool_calls) {
            const tool = record(rawTool)
            if (!tool) continue
            const toolIndex = Number(tool.index || 0)
            const fn = record(tool.function)
            let state = tools.get(toolIndex)
            if (!state) {
              state = { blockIndex: nextIndex++, id: typeof tool.id === 'string' ? tool.id : `toolu_${crypto.randomUUID().replace(/-/g, '')}`, name: typeof fn?.name === 'string' ? fn.name : 'tool' }
              tools.set(toolIndex, state)
              openBlocks.add(state.blockIndex)
              await emit('content_block_start', { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} } })
            }
            if (typeof fn?.arguments === 'string' && fn.arguments) await emit('content_block_delta', { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: fn.arguments } })
          }
        }
      }
      if (choice?.finish_reason) await finish(choice.finish_reason)
    }
  }
  parser.reset({ consume: true })
  await finish('stop')
  return usage
}
