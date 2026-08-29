import { readFile } from 'node:fs/promises'

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function positiveInteger(value, fallback, maximum = 100) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

const baseUrl = required('EDGE_PROBE_URL').replace(/\/+$/, '')
const hubKey = required('EDGE_PROBE_HUB_KEY')
const model = required('EDGE_PROBE_MODEL')
const concurrency = positiveInteger(process.env.EDGE_PROBE_CONCURRENCY, 3, 20)
const timeoutMs = positiveInteger(process.env.EDGE_PROBE_TIMEOUT_MS, 120000, 600000)

function headers(extra = {}) {
  return { authorization: `Bearer ${hubKey}`, ...extra }
}

async function fetchTimed(path, options = {}) {
  const startedAt = performance.now()
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: headers(options.headers),
    signal: AbortSignal.timeout(timeoutMs)
  })
  return { response, headersMs: performance.now() - startedAt, startedAt }
}

async function modelsProbe() {
  const { response, headersMs } = await fetchTimed('/v1/models')
  const payload = await response.json().catch(() => null)
  const models = Array.isArray(payload?.data) ? payload.data.map(item => item?.id).filter(Boolean) : []
  return { ok: response.ok && models.includes(model), status: response.status, headersMs, modelVisible: models.includes(model) }
}

async function responseProbe(input, stream = false) {
  const { response, headersMs, startedAt } = await fetchTimed('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input, stream, store: false })
  })
  if (!stream) {
    await response.arrayBuffer()
    return { ok: response.ok, status: response.status, headersMs, totalMs: performance.now() - startedAt }
  }

  const reader = response.body?.getReader()
  if (!reader) return { ok: false, status: response.status, headersMs, firstChunkMs: null, totalMs: performance.now() - startedAt, completed: false }
  let firstChunkMs = null
  let content = ''
  const decoder = new TextDecoder()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    if (firstChunkMs === null) firstChunkMs = performance.now() - startedAt
    content += decoder.decode(next.value, { stream: true })
  }
  content += decoder.decode()
  const completed = /(?:event:\s*response\.completed|"type"\s*:\s*"response\.completed")/.test(content)
  return { ok: response.ok && completed, status: response.status, headersMs, firstChunkMs, totalMs: performance.now() - startedAt, completed }
}

async function uploadProbe(path) {
  const image = await readFile(path)
  const form = new FormData()
  form.set('model', String(process.env.EDGE_PROBE_IMAGE_MODEL || model))
  form.set('image', new Blob([image]), path.split('/').pop() || 'probe.png')
  const { response, headersMs, startedAt } = await fetchTimed('/v1/images/edits', { method: 'POST', body: form })
  await response.arrayBuffer()
  return {
    // A 4xx response means the upload contract was rejected just as much as
    // a 5xx response; only a successful HTTP response is a passing probe.
    ok: response.ok,
    status: response.status,
    bytes: image.length,
    headersMs,
    totalMs: performance.now() - startedAt
  }
}

async function notify(result) {
  const webhookUrl = String(process.env.EDGE_PROBE_WEBHOOK_URL || '').trim()
  const notifyAlways = String(process.env.EDGE_PROBE_NOTIFY_ALWAYS || '').toLowerCase() === 'true'
  if (!webhookUrl || result.passed && !notifyAlways) return { sent: false }
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`)
  return { sent: true }
}

async function main() {
  const models = await modelsProbe()
  const nonStreaming = await responseProbe('Return exactly: edge probe ok')
  const streaming = await responseProbe('Return exactly: streaming edge probe ok', true)
  const concurrent = await Promise.all(Array.from({ length: concurrency }, (_, index) => responseProbe(`Return exactly: concurrent probe ${index + 1}`)))
  const upload = process.env.EDGE_PROBE_IMAGE ? await uploadProbe(process.env.EDGE_PROBE_IMAGE) : null
  const result = {
    generatedAt: new Date().toISOString(),
    target: new URL(baseUrl).host,
    passed: models.ok && nonStreaming.ok && streaming.ok && concurrent.every(item => item.ok) && (!upload || upload.ok),
    models,
    nonStreaming,
    streaming,
    concurrent: {
      requested: concurrency,
      passed: concurrent.filter(item => item.ok).length,
      maximumTotalMs: Math.max(...concurrent.map(item => item.totalMs))
    },
    upload
  }
  try {
    result.notification = await notify(result)
  } catch (error) {
    result.notification = { sent: false, error: error instanceof Error ? error.message : String(error) }
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.passed || result.notification.error) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
