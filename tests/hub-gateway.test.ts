import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentHash, createHubKey, decryptSecret, encryptSecret, hashHubKey } from '../server/utils/hub-crypto'
import { budgetUpstreamReadableStream, createUpstreamResponseBudget, endpointName, extractUsage, normalizeResponseForArchive, normalizeUpstreamError, readRequestBodyLimited, readUpstreamBodyLimited, readUpstreamChunk, replaceMultipartModel, reserveBodyMemory, sanitizeArchiveBody, UPSTREAM_RESPONSE_LIMITS, writeResponseChunk } from '../server/services/hub-gateway'
import { resolveAnalyticsRange } from '../server/services/hub-analytics'
import { startOfZoned, zonedDateKey } from '../server/utils/time-zone'
import { buildKeyActivityResponse, isKeyActivityRequest, keyActivityRange } from '../server/services/key-activity'
import { activityLogQuery } from '../shared/utils/admin-log-query'
import { discoverUpstreamModelIds, mergeDiscoveredModelMappings, modelIdsFromPayload, modelsFromPayload, userDiscoveredModelPlan } from '../server/services/hub-model-discovery'

afterEach(() => vi.unstubAllGlobals())

function stubSecrets() {
  vi.stubGlobal('useRuntimeConfig', () => ({
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    hubKeyPepper: 'test-pepper-with-at-least-thirty-two-characters'
  }))
}

describe('Hub credential security', () => {
  it('encrypts upstream secrets with authenticated encryption', () => {
    stubSecrets()
    const encrypted = encryptSecret('upstream-secret')
    expect(encrypted).not.toContain('upstream-secret')
    expect(decryptSecret(encrypted)).toBe('upstream-secret')
  })

  it('creates opaque Hub Keys and stable keyed hashes', () => {
    stubSecrets()
    const key = createHubKey()
    expect(key).toMatch(/^zh-[A-Za-z0-9_-]{40,}$/)
    expect(hashHubKey(key)).toBe(hashHubKey(` ${key} `))
    expect(hashHubKey(key)).not.toContain(key)
  })

  it('creates stable SHA-256 hashes for archived bodies', () => {
    expect(contentHash(Buffer.from('{"model":"gpt-5"}'))).toBe('777710df5ad26b1238811b40c77267c73e7f8eba12cde87f5b2c1560ef758259')
  })
})

describe('OpenAI gateway normalization', () => {
  it('times out only when a streamed body remains idle', async () => {
    const controller = new AbortController()
    const reader = { read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}) }
    await expect(readUpstreamChunk(reader, 10, controller)).rejects.toThrow('Upstream stream was idle for 10 ms')
    expect(controller.signal.aborted).toBe(true)
  })

  it('rejects declared standard and error responses above their limits without buffering them', async () => {
    for (const [limit, label] of [
      [UPSTREAM_RESPONSE_LIMITS.standardBytes, 'Upstream response'],
      [UPSTREAM_RESPONSE_LIMITS.errorBytes, 'Upstream error response']
    ] as const) {
      const controller = new AbortController()
      const response = new Response('small body', {
        headers: { 'content-length': String(limit + 1) }
      })

      await expect(readUpstreamBodyLimited(response, controller, limit, { label })).rejects.toMatchObject({
        code: 'UPSTREAM_RESPONSE_TOO_LARGE',
        statusCode: 502
      })
      expect(controller.signal.aborted).toBe(true)
      expect(controller.signal.reason).toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
    }
  })

  it('aborts a streaming response immediately when its byte budget is exceeded', () => {
    const controller = new AbortController()
    const budget = createUpstreamResponseBudget(controller, { maxBytes: 5, label: 'Test stream' })
    try {
      expect(() => budget.accountBytes(6)).toThrow('Test stream exceeds 5 bytes')
      expect(controller.signal.aborted).toBe(true)
      expect(controller.signal.reason).toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE', statusCode: 502 })
    } finally {
      budget.finish()
    }
  })

  it('tracks passthrough upstream and output bytes as independent lanes', () => {
    const controller = new AbortController()
    const budget = createUpstreamResponseBudget(controller, { maxBytes: 3, label: 'Test stream' })
    try {
      expect(budget.accountBytes(3, 'upstream')).toBe(3)
      expect(budget.accountBytes(3, 'output')).toBe(3)
      expect(budget.totals).toEqual({ upstream: 3, output: 3 })
      expect(controller.signal.aborted).toBe(false)
    } finally {
      budget.finish()
    }
  })

  it('aborts work blocked past the streaming response deadline', async () => {
    const controller = new AbortController()
    const budget = createUpstreamResponseBudget(controller, { maxBytes: 5, timeoutMs: 10, label: 'Test stream' })
    try {
      await expect(budget.guard(new Promise<never>(() => {}))).rejects.toMatchObject({
        code: 'UPSTREAM_STREAM_TIMEOUT',
        statusCode: 502
      })
      expect(controller.signal.aborted).toBe(true)
      expect(controller.signal.reason).toMatchObject({ code: 'UPSTREAM_STREAM_TIMEOUT' })
    } finally {
      budget.finish()
    }
  })

  it('counts every upstream body chunk and aborts when their total exceeds the limit', async () => {
    const controller = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(Uint8Array.from([1, 2, 3]))
        target.enqueue(Uint8Array.from([4, 5, 6]))
        target.close()
      }
    }))

    await expect(readUpstreamBodyLimited(response, controller, 5)).rejects.toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      statusCode: 502
    })
    expect(controller.signal.aborted).toBe(true)
  })

  it('does not wait for a stalled stream cancellation after exceeding the limit', async () => {
    let finishCancellation: (() => void) | undefined
    let cancellationStarted = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cancellation = new Promise<void>((resolve) => { finishCancellation = resolve })
    const controller = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(Uint8Array.from([1, 2, 3]))
        target.enqueue(Uint8Array.from([4, 5, 6]))
      },
      cancel() {
        cancellationStarted = true
        return cancellation
      }
    }))
    const didNotReturn = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('response limit waited for stream cancellation')), 100)
    })

    try {
      await expect(Promise.race([
        readUpstreamBodyLimited(response, controller, 5),
        didNotReturn
      ])).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE', statusCode: 502 })
      expect(cancellationStarted).toBe(true)
    } finally {
      if (timeout) clearTimeout(timeout)
      finishCancellation?.()
    }
  })

  it('errors a budgeted conversion stream without waiting for upstream cancellation', async () => {
    let finishCancellation: (() => void) | undefined
    let cancellationStarted = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cancellation = new Promise<void>((resolve) => { finishCancellation = resolve })
    const controller = new AbortController()
    const budget = createUpstreamResponseBudget(controller, { maxBytes: 5, label: 'Converted stream' })
    const upstream = new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(Uint8Array.from([1, 2, 3, 4, 5, 6]))
      },
      cancel() {
        cancellationStarted = true
        return cancellation
      }
    })
    const reader = budgetUpstreamReadableStream(upstream, budget, 1000).getReader()
    const didNotReturn = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('conversion stream waited for upstream cancellation')), 100)
    })

    try {
      await expect(Promise.race([reader.read(), didNotReturn])).rejects.toMatchObject({
        code: 'UPSTREAM_RESPONSE_TOO_LARGE',
        statusCode: 502
      })
      expect(cancellationStarted).toBe(true)
      expect(controller.signal.aborted).toBe(true)
    } finally {
      if (timeout) clearTimeout(timeout)
      finishCancellation?.()
      budget.finish()
    }
  })

  it('stops waiting for response backpressure when the client closes', async () => {
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: () => false
    })
    const writing = writeResponseChunk(response, Buffer.from('chunk'))
    queueMicrotask(() => response.emit('close'))
    await expect(writing).resolves.toBe(false)
  })

  it('releases immediately without consuming capacity when the connection already closed', () => {
    const request = new Readable({ read() {} })
    request.destroy()
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false })
    const event = { node: { req: request, res: response } }
    const memory = reserveBodyMemory(event as never, 64 * 1024 * 1024, () => { throw new Error('capacity exhausted') })

    expect(memory.reservation).toEqual({ bytes: 0, released: true })
    expect(() => memory.grow(1)).toThrow('Client connection closed while reading request body')

    const activeRequest = new Readable({ read() {} })
    const activeResponse = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false })
    const activeEvent = { node: { req: activeRequest, res: activeResponse } }
    const fullCapacity = reserveBodyMemory(activeEvent as never, 256 * 1024 * 1024, () => { throw new Error('capacity exhausted') })
    try {
      expect(fullCapacity.reservation.bytes).toBe(256 * 1024 * 1024)
    } finally {
      fullCapacity.release()
      activeRequest.destroy()
    }
  })

  it('rejects a request body that remains idle using a real memory reservation', async () => {
    const request = new Readable({ read() {} })
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false })
    const event = { node: { req: request, res: response } }
    const memory = reserveBodyMemory(event as never, 64)
    const timeoutKinds: string[] = []
    try {
      await expect(readRequestBodyLimited(
        event as never,
        1024,
        memory,
        () => { throw new Error('too large') },
        {
          idleTimeoutMs: 10,
          totalTimeoutMs: 1000,
          onTimeout: (kind) => {
            timeoutKinds.push(kind)
            throw new Error('request body idle timeout')
          }
        }
      )).rejects.toThrow('request body idle timeout')
      expect(timeoutKinds).toEqual(['idle'])
      expect(memory.reservation).toEqual({ bytes: 64, released: false })
      response.emit('finish')
      expect(memory.reservation.released).toBe(true)
    } finally {
      memory.release()
      request.destroy()
    }
  })

  it('enforces the total body deadline even while small chunks keep arriving', async () => {
    let pump: ReturnType<typeof setInterval> | undefined
    const request = new Readable({
      read() {
        pump ||= setInterval(() => this.push(Buffer.from('x')), 2)
      }
    })
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false })
    const event = { node: { req: request, res: response } }
    const memory = reserveBodyMemory(event as never, 0)
    const timeoutKinds: string[] = []
    try {
      await expect(readRequestBodyLimited(
        event as never,
        1024,
        memory,
        () => { throw new Error('too large') },
        {
          idleTimeoutMs: 200,
          totalTimeoutMs: 30,
          onTimeout: (kind) => {
            timeoutKinds.push(kind)
            throw new Error('request body total timeout')
          }
        }
      )).rejects.toThrow('request body total timeout')
      expect(timeoutKinds).toEqual(['total'])
      expect(memory.reservation.bytes).toBeGreaterThan(0)
    } finally {
      if (pump) clearInterval(pump)
      memory.release()
      request.destroy()
    }
  })

  it('discovers and normalizes OpenAI-compatible upstream models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-image-1' }, { id: 'gpt-5.6-sol' }, { missing: true }]
    }), { status: 200 })))
    await expect(discoverUpstreamModelIds('https://upstream.example.com/v1/', 'secret')).resolves.toEqual([
      'gpt-5.6-sol',
      'gpt-image-1'
    ])
    expect(fetch).toHaveBeenCalledWith('https://upstream.example.com/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer secret' }
    }))
  })

  it('reads unambiguous per-million pricing from the model catalog', () => {
    expect(modelsFromPayload({ data: [{ id: 'glm-5.3', pricing: { input_per_million: 2, output_per_million: '8', currency: 'cny' } }] })).toEqual([{ id: 'glm-5.3', inputPerMillion: 2, outputPerMillion: 8, cachedPerMillion: null, reasoningPerMillion: null, currency: 'CNY' }])
  })

  it('rejects malformed model entries without duplicating valid IDs', () => {
    expect(modelIdsFromPayload({ data: [' model-a ', { id: 'model-a' }, { id: 'model-b' }, null, 42] })).toEqual([
      'model-a',
      'model-b'
    ])
    expect(modelIdsFromPayload({ models: [{ id: 'wrong-shape' }] })).toEqual([])
  })

  it('keeps automatic models while allowing manual mappings to override them', () => {
    expect(mergeDiscoveredModelMappings(['model-a', 'model-b'], [{
      publicModel: 'model-a',
      upstreamModel: 'provider-model-a',
      enabled: true,
      endpoints: ['/v1/responses']
    }, {
      publicModel: 'custom-alias',
      upstreamModel: 'model-b',
      enabled: true,
      endpoints: []
    }])).toEqual([
      { publicModel: 'model-a', upstreamModel: 'provider-model-a', enabled: true, endpoints: ['/v1/responses'] },
      { publicModel: 'model-b', upstreamModel: 'model-b', enabled: true, endpoints: [] },
      { publicModel: 'custom-alias', upstreamModel: 'model-b', enabled: true, endpoints: [] }
    ])
  })

  it('reconciles a private relay to the models currently visible to its API key', () => {
    expect(userDiscoveredModelPlan('a9729e39-56bb-4a6e-8148-493e5f86a546', ['gpt-5.6', 'gpt-5.6-codex'], [
      { id: 'stale', publicModel: 'gpt-5.6-sol', upstreamModel: 'gpt-5.6-sol', enabled: true },
      { id: 'current', publicModel: 'gpt-5.6', upstreamModel: 'gpt-5.6', enabled: true },
      { id: 'restored', publicModel: 'gpt-5.6-codex', upstreamModel: 'gpt-5.6-codex', enabled: false },
      { id: 'legacy', publicModel: 'relay/a9729e39/gpt-5.6', upstreamModel: 'gpt-5.6', enabled: true }
    ])).toEqual({ staleIds: ['stale', 'legacy'], reactivatedIds: ['restored'] })
  })

  it('accepts only the documented endpoint set', () => {
    expect(endpointName('chat/completions')).toBe('/v1/chat/completions')
    expect(endpointName('images/generations')).toBe('/v1/images/generations')
    expect(() => endpointName('audio/transcriptions')).toThrow()
  })

  it('reads Chat Completions token details', () => {
    const usage = extractUsage(Buffer.from(JSON.stringify({ usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 12 }
    } })), 'application/json')
    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedTokens: 80, reasoningTokens: 12 })
  })

  it('reads usage from streamed Responses events', () => {
    const payload = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":42,"output_tokens":9,"total_tokens":51}}}',
      ''
    ].join('\n')
    expect(extractUsage(Buffer.from(payload), 'text/event-stream')).toMatchObject({ inputTokens: 42, outputTokens: 9, totalTokens: 51 })
  })

  it('counts generated image results', () => {
    expect(extractUsage(Buffer.from('{"data":[{"b64_json":"a"},{"b64_json":"b"}]}'), 'application/json').imageCount).toBe(2)
    expect(extractUsage(Buffer.from('{"output":[{"type":"image_generation_call","result":"base64"}]}'), 'application/json').imageCount).toBe(1)
  })

  it('normalizes non-OpenAI upstream errors and preserves compatible shapes', () => {
    const normalized = JSON.parse(normalizeUpstreamError(Buffer.from('{"message":"bad input"}'), 400).toString())
    expect(normalized.error).toMatchObject({ message: 'bad input', type: 'invalid_request_error', code: 'upstream_error' })
    const compatible = Buffer.from('{"error":{"message":"already compatible","type":"invalid_request_error"}}')
    expect(JSON.parse(normalizeUpstreamError(compatible, 400).toString())).toEqual({ error: { message: 'already compatible', type: 'invalid_request_error' } })
  })

  it('redacts reflected credentials from compatible upstream errors', () => {
    const normalized = JSON.parse(normalizeUpstreamError(Buffer.from(JSON.stringify({
      error: { message: 'Authorization: Bearer upstream-secret', setup_token: 'setup-secret' },
      request: { api_key: 'sk-sensitive-value' }
    })), 401).toString())
    expect(JSON.stringify(normalized)).not.toContain('upstream-secret')
    expect(JSON.stringify(normalized)).not.toContain('setup-secret')
    expect(JSON.stringify(normalized)).not.toContain('sk-sensitive-value')
    expect(normalized.error.message).toContain('[REDACTED]')
  })

  it('normalizes failed upstream responses before they become archivable', () => {
    const upstream = Buffer.from(JSON.stringify({
      error: { message: 'Authorization: Bearer platform-upstream-secret' },
      request: { api_key: 'sk-platform-sensitive-value' }
    }))
    const archived = normalizeResponseForArchive(
      upstream,
      { ok: false, status: 401, statusText: 'Unauthorized' },
      'application/problem+json'
    )

    expect(upstream.toString('utf8')).toContain('platform-upstream-secret')
    expect(archived.contentType).toBe('application/json; charset=utf-8')
    expect(archived.body.toString('utf8')).not.toContain('platform-upstream-secret')
    expect(archived.body.toString('utf8')).not.toContain('sk-platform-sensitive-value')
  })

  it('replaces upstream errors with the configured client-facing message', () => {
    const normalized = JSON.parse(normalizeUpstreamError(
      Buffer.from('{"error":{"message":"provider capacity exhausted"}}'),
      503,
      'Service Unavailable',
      '当前上游暂不可用，请联系管理员'
    ).toString())
    expect(normalized.error).toEqual({
      message: '当前上游暂不可用，请联系管理员',
      type: 'server_error',
      param: null,
      code: 'upstream_error'
    })
  })

  it('rewrites a multipart model alias without changing binary image bytes', () => {
    const binary = Buffer.from([0, 255, 13, 10, 45, 45, 42, 7])
    const before = Buffer.from('--hub-boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\nhub-image\r\n--hub-boundary\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n')
    const after = Buffer.from('\r\n--hub-boundary--\r\n')
    const source = Buffer.concat([before, binary, after])
    const rewritten = replaceMultipartModel(source, 'multipart/form-data; boundary=hub-boundary', 'upstream-image')
    expect(rewritten.includes(Buffer.from('\r\n\r\nupstream-image\r\n'))).toBe(true)
    expect(rewritten.subarray(rewritten.indexOf(binary), rewritten.indexOf(binary) + binary.length)).toEqual(binary)
  })

  it('redacts authentication fields only in the archived JSON copy', () => {
    const source = Buffer.from(JSON.stringify({
      model: 'gpt-5',
      input: 'keep this prompt',
      headers: { Authorization: 'Bearer client-secret', Cookie: 'session=secret' },
      tool: { api_key: 'tool-secret', accessToken: 'access-secret' }
    }))
    const archived = JSON.parse(sanitizeArchiveBody(source, 'application/json').toString('utf8'))
    expect(archived).toEqual({
      model: 'gpt-5',
      input: 'keep this prompt',
      headers: { Authorization: '[REDACTED]', Cookie: '[REDACTED]' },
      tool: { api_key: '[REDACTED]', accessToken: '[REDACTED]' }
    })
    expect(source.toString('utf8')).toContain('Bearer client-secret')
  })
})

describe('analytics ranges', () => {
  it('distinguishes rolling 24 hours from Shanghai today', () => {
    const today = resolveAnalyticsRange({ range: 'today' })
    const rolling = resolveAnalyticsRange({ range: '24h' })
    expect(today.from.getTime()).not.toBe(rolling.from.getTime())
    expect(rolling.to.getTime() - rolling.from.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('validates custom ranges', () => {
    const range = resolveAnalyticsRange({ range: 'custom', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })
    expect(range.to.getTime() - range.from.getTime()).toBe(24 * 60 * 60 * 1000)
    expect(() => resolveAnalyticsRange({ range: 'custom', from: '2026-01-02', to: '2026-01-01' })).toThrow()
    expect(() => resolveAnalyticsRange({ range: 'custom', from: '2026-01-01' })).toThrow()
    expect(() => resolveAnalyticsRange({ range: 'unexpected' })).toThrow()
  })

  it('uses the configured timezone for calendar boundaries', () => {
    const instant = new Date('2026-01-01T01:30:00Z')
    expect(zonedDateKey(instant, 'Asia/Shanghai')).toBe('2026-01-01')
    expect(zonedDateKey(instant, 'America/Los_Angeles')).toBe('2025-12-31')
    expect(startOfZoned(instant, 'day', 'America/Los_Angeles').toISOString()).toBe('2025-12-31T08:00:00.000Z')
  })
})

describe('Key activity', () => {
  const timezone = 'Asia/Shanghai'
  const dateKey = '2026-07-29'
  const range = keyActivityRange(dateKey, timezone)
  const generatedAt = new Date('2026-07-29T04:04:00.000Z').getTime()

  it('uses system-timezone day boundaries and creates exactly 24 zero-filled buckets', () => {
    expect(range.from.toISOString()).toBe('2026-07-28T16:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-07-29T16:00:00.000Z')
    const result = buildKeyActivityResponse({
      timezone, dateKey, from: range.from.getTime(), to: range.to.getTime(), generatedAt,
      keys: [{ id: 'idle', name: 'Idle Key', maskedKey: 'zh-idle...0000', status: 'disabled' }], rows: []
    })
    expect(result.keys[0]?.buckets).toHaveLength(24)
    expect(result.keys[0]?.buckets.every(bucket => bucket.requests === 0 && bucket.tokens === 0 && bucket.cost === 0)).toBe(true)
    expect(result.keys[0]).toMatchObject({ requests: 0, lastSeenAt: null, recentlyActive: false, status: 'disabled' })
  })

  it('counts success, error, stream-aborted and pending activity separately', () => {
    const result = buildKeyActivityResponse({
      timezone, dateKey, from: range.from.getTime(), to: range.to.getTime(), generatedAt,
      keys: [{ id: 'active', name: 'Active Key', maskedKey: 'zh-live...0001', status: 'active' }],
      rows: [{ keyId: 'active', slot: 12, requests: 4, successes: 1, failures: 2, pending: 1, tokens: 70, cost: 0.04, lastSeenAt: generatedAt - 60_000 }]
    })
    expect(result).toMatchObject({ activeCount: 1, recentlyActiveCount: 1 })
    expect(result.keys[0]).toMatchObject({ requests: 4, successes: 1, failures: 2, pending: 1, tokens: 70, cost: 0.04, recentlyActive: true })
    expect(result.keys[0]?.buckets[12]).toMatchObject({ requests: 4, failures: 2 })
  })

  it('excludes model discovery and requests without an identified Key', () => {
    expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/models', status: 'success' })).toBe(false)
    expect(isKeyActivityRequest({ keyId: null, endpoint: '/v1/responses', status: 'error' })).toBe(false)
    for (const status of ['success', 'error', 'stream_aborted', 'pending']) {
      expect(isKeyActivityRequest({ keyId: 'key', endpoint: '/v1/responses', status })).toBe(true)
    }
  })

  it('builds an exact one-hour log drill-down range', () => {
    const bucket = new Date('2026-07-29T03:00:00.000Z').getTime()
    expect(activityLogQuery('key-id', bucket)).toEqual({
      keyId: 'key-id', from: '2026-07-29T03:00:00.000Z', to: '2026-07-29T04:00:00.000Z'
    })
  })
})
