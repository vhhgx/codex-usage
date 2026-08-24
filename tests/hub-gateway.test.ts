import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentHash, createHubKey, decryptSecret, encryptSecret, hashHubKey } from '../server/utils/hub-crypto'
import { endpointName, extractUsage, normalizeUpstreamError, readUpstreamChunk, replaceMultipartModel, sanitizeArchiveBody, writeResponseChunk } from '../server/services/hub-gateway'
import { resolveAnalyticsRange } from '../server/services/hub-analytics'
import { startOfZoned, zonedDateKey } from '../server/utils/time-zone'
import { buildKeyActivityResponse, isKeyActivityRequest, keyActivityRange } from '../server/services/key-activity'
import { activityLogQuery } from '../shared/utils/admin-log-query'
import { discoverUpstreamModelIds, mergeDiscoveredModelMappings, modelIdsFromPayload, userDiscoveredModelPlan } from '../server/services/hub-model-discovery'

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

  it('normalizes non-OpenAI upstream errors and preserves compatible ones', () => {
    const normalized = JSON.parse(normalizeUpstreamError(Buffer.from('{"message":"bad input"}'), 400).toString())
    expect(normalized.error).toMatchObject({ message: 'bad input', type: 'invalid_request_error', code: 'upstream_error' })
    const compatible = Buffer.from('{"error":{"message":"already compatible","type":"invalid_request_error"}}')
    expect(normalizeUpstreamError(compatible, 400)).toBe(compatible)
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
