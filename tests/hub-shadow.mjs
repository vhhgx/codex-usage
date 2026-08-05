import assert from 'node:assert/strict'

const baseUrl = (process.env.HUB_SHADOW_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '')
const username = process.env.HUB_SHADOW_ADMIN_USERNAME || ''
const password = process.env.HUB_SHADOW_ADMIN_PASSWORD || ''
const cpaChannelId = process.env.HUB_SHADOW_CPA_CHANNEL_ID || ''
const sub2apiChannelId = process.env.HUB_SHADOW_SUB2API_CHANNEL_ID || ''
const runRequests = process.env.HUB_SHADOW_RUN_REQUESTS === '1'
const routedEndpoints = ['/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/images/generations', '/v1/images/edits']

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function cookieFrom(response) {
  return (response.headers.get('set-cookie') || '').split(';', 1)[0]
}

async function json(response) {
  const text = await response.text()
  const value = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${response.url}: ${text.slice(0, 1000)}`)
  return value
}

function preferredMapping(channel) {
  const requested = channel.type === 'cpa'
    ? process.env.HUB_SHADOW_CPA_MODEL
    : process.env.HUB_SHADOW_SUB2API_MODEL
  const enabled = channel.models.filter(model => model.enabled)
  const mapping = requested
    ? enabled.find(model => model.publicModel === requested)
    : enabled[0]
  if (!mapping) throw new Error(`${channel.name} has no enabled mapping${requested ? ` for ${requested}` : ''}`)
  return mapping
}

function smokeRequest(endpoint, model) {
  if (endpoint === '/v1/chat/completions') {
    return { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }
  }
  if (endpoint === '/v1/responses') {
    return { model, input: 'Reply with OK.', max_output_tokens: 16 }
  }
  if (endpoint === '/v1/embeddings') return { model, input: 'shadow health check' }
  if (endpoint === '/v1/images/generations' && process.env.HUB_SHADOW_ALLOW_IMAGES === '1') {
    return { model, prompt: 'A small solid gray square', size: '1024x1024', n: 1 }
  }
  return null
}

async function main() {
  required('HUB_SHADOW_ADMIN_USERNAME', username)
  required('HUB_SHADOW_ADMIN_PASSWORD', password)
  required('HUB_SHADOW_CPA_CHANNEL_ID', cpaChannelId)
  required('HUB_SHADOW_SUB2API_CHANNEL_ID', sub2apiChannelId)

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const loginBody = await json(login)
  assert.equal(loginBody.user.username, username)
  const cookie = cookieFrom(login)
  assert(cookie)

  const admin = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        cookie,
        origin: baseUrl,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers
      }
    })
    return json(response)
  }

  const channels = (await admin('/api/admin/channels')).channels
  const cpa = channels.find(channel => channel.id === cpaChannelId)
  const sub2api = channels.find(channel => channel.id === sub2apiChannelId)
  assert(cpa, `CPA channel not found: ${cpaChannelId}`)
  assert(sub2api, `Sub2API channel not found: ${sub2apiChannelId}`)
  assert.equal(cpa.type, 'cpa')
  assert.equal(sub2api.type, 'sub2api')
  assert(cpa.enabled && sub2api.enabled, 'Both shadow channels must be enabled')

  const health = {}
  for (const channel of [cpa, sub2api]) {
    const result = await admin(`/api/admin/channels/${channel.id}/test`, { method: 'POST' })
    assert.equal(result.healthy, true, `${channel.name} health check failed: ${result.message || 'unknown error'}`)
    health[channel.type] = { latencyMs: result.latencyMs }
  }

  const refreshed = (await admin('/api/admin/channels')).channels
  const selected = refreshed.filter(channel => [cpaChannelId, sub2apiChannelId].includes(channel.id))
  assert(selected.every(channel => channel.healthStatus === 'healthy'))
  assert(selected.every(channel => channel.circuitState === 'closed'))
  const mappings = selected.map(channel => ({ channel, model: preferredMapping(channel) }))
  const publicModels = [...new Set(mappings.map(item => item.model.publicModel))]
  const endpointsFor = model => model.endpoints.length ? model.endpoints : routedEndpoints
  const endpoints = [...new Set(mappings.flatMap(item => endpointsFor(item.model)))]
  if (runRequests) {
    assert.equal(publicModels.length, mappings.length, 'Billable shadow checks require distinct public model aliases for CPA and Sub2API')
    for (const { channel, model } of mappings) {
      const owners = refreshed.filter(item => item.enabled && item.models.some(candidate => candidate.enabled && candidate.publicModel === model.publicModel))
      assert.deepEqual(owners.map(item => item.id), [channel.id], `Shadow alias must route only to ${channel.name}: ${model.publicModel}`)
    }
  }
  let keyId = ''

  try {
    const keyResult = await admin('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: `Shadow validation ${new Date().toISOString()}`,
        note: 'Automatically removed by test:hub-shadow',
        expiresInDays: 1,
        allowedModels: publicModels,
        allowedEndpoints: ['/v1/models', ...endpoints],
        rpmLimit: 10,
        concurrencyLimit: 2,
        totalRequestLimit: 20
      })
    })
    keyId = keyResult.item.id
    const authorization = { authorization: `Bearer ${keyResult.key}` }
    const modelsResponse = await fetch(`${baseUrl}/v1/models`, { headers: authorization })
    const models = await json(modelsResponse)
    const visible = new Set(models.data.map(item => item.id))
    publicModels.forEach(model => assert(visible.has(model), `Model is not visible through Hub: ${model}`))

    const smoke = []
    if (runRequests) {
      for (const { channel, model } of mappings) {
        const candidates = endpointsFor(model)
          .map(endpoint => ({ endpoint, body: smokeRequest(endpoint, model.publicModel) }))
          .filter(item => item.body)
        const request = candidates[0]
        if (!request) throw new Error(`${channel.name} has no supported low-impact smoke endpoint`)
        const response = await fetch(`${baseUrl}${request.endpoint}`, {
          method: 'POST',
          headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify(request.body)
        })
        const body = await json(response)
        smoke.push({ type: channel.type, model: model.publicModel, endpoint: request.endpoint, requestId: response.headers.get('x-request-id'), responseObject: body?.object || null })
      }
    }

    console.log(JSON.stringify({
      passed: true,
      hub: baseUrl,
      health,
      models: publicModels,
      billableSmokeRun: runRequests,
      smoke
    }))
  } finally {
    if (keyId) await admin(`/api/admin/keys/${keyId}`, { method: 'DELETE' }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
