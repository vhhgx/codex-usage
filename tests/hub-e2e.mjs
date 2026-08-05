import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import Redis from 'ioredis'
import postgres from 'postgres'

const databaseName = 'zephyr_hub_e2e'
const databaseAdminUrl = process.env.HUB_E2E_DATABASE_ADMIN_URL || 'postgres://zephyr:zephyr-change-me@127.0.0.1:5432/postgres'
const databaseUrl = databaseAdminUrl.replace(/\/[^/?]+(?=\?|$)/, `/${databaseName}`)
const redisUrl = process.env.HUB_E2E_REDIS_URL || 'redis://127.0.0.1:6379/14'
const s3Endpoint = process.env.HUB_E2E_S3_ENDPOINT || 'http://127.0.0.1:9000'
const s3Bucket = process.env.HUB_E2E_S3_BUCKET || 'zephyr-hub-e2e'
const s3AccessKeyId = process.env.HUB_E2E_S3_ACCESS_KEY_ID || 'zephyr'
const s3SecretAccessKey = process.env.HUB_E2E_S3_SECRET_ACCESS_KEY || 'zephyr-minio-change-me'
const adminUsername = 'hub-e2e-admin'
const adminPassword = 'hub-e2e-password-2026'
const origin = 'http://127.0.0.1'
const imageBytes = Buffer.from([0, 255, 13, 10, 45, 45, 42, 7, 128, 1, 2, 3, 254])

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function createUpstream(role, state) {
  return createServer(async (request, response) => {
    const body = await readBody(request)
    const path = request.url || ''
    if (path === '/v1/models') return json(response, 200, { object: 'list', data: [] })

    const capture = {
      path,
      authorization: request.headers.authorization || '',
      forwarded: request.headers.forwarded || '',
      forwardedFor: request.headers['x-forwarded-for'] || '',
      realIp: request.headers['x-real-ip'] || '',
      contentType: request.headers['content-type'] || '',
      body
    }
    state.captures.push(capture)

    if (path === '/v1/chat/completions') {
      const payload = JSON.parse(body.toString('utf8'))
      if (role === 'primary' && state.nonStreamBodyFailure && payload.stream !== true) {
        state.nonStreamChat += 1
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' })
        response.write('{"id":"partial"')
        await delay(20)
        response.destroy()
        return
      }
      if (payload.stream === true && role === 'primary') {
        state.streamChat += 1
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"id":"chat-abort","choices":[{"delta":{"content":"partial"}}]}\n\n')
        await delay(80)
        response.destroy()
        return
      }
      if (role === 'primary') {
        state.nonStreamChat += 1
        if (state.primaryChatHealthy) {
          return json(response, 200, {
            id: 'chat-primary',
            object: 'chat.completion',
            model: payload.model,
            source: 'primary',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
          })
        }
        return json(response, 503, { error: { message: 'injected primary failure' } })
      }
      state.nonStreamChat += 1
      return json(response, 200, {
        id: 'chat-fallback',
        object: 'chat.completion',
        model: payload.model,
        source: 'fallback',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      })
    }

    if (path === '/v1/responses' && role === 'primary') {
      const payload = JSON.parse(body.toString('utf8'))
      state.responses += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (payload.input === 'long active stream') {
        for (let index = 0; index < 4; index++) {
          await delay(350)
          response.write(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${index}"}\n\n`)
        }
        response.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":4,"total_tokens":9}}}\n\n')
        return
      }
      if (payload.input === 'client abort') {
        for (let index = 0; index < 10 && !response.destroyed; index++) {
          response.write(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${index}"}\n\n`)
          await delay(200)
        }
        if (!response.destroyed) response.end()
        return
      }
      await delay(150)
      response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n')
      await delay(350)
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n')
      return
    }

    if (path === '/v1/images/edits' && role === 'primary') {
      state.imageEdits += 1
      state.multipart = capture
      if (state.imageNetworkFailure) {
        response.destroy()
        return
      }
      return json(response, 200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] })
    }

    if (path === '/v1/images/generations' && role === 'primary') {
      state.imageGenerations += 1
      return json(response, 200, { created: 1, data: [{ b64_json: 'Z2VuZXJhdGVk' }] })
    }

    if (path === '/v1/embeddings') {
      state.embeddings += 1
      if (role === 'primary') {
        state.resolveEmbeddingStarted?.()
        await delay(state.embeddingDelayMs || 300)
      }
      return json(response, 200, {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        model: `upstream-${role}`,
        source: role,
        usage: { prompt_tokens: 3, total_tokens: 3 }
      })
    }

    json(response, 500, { error: { message: `unexpected ${role} request: ${path}` } })
  })
}

async function waitForApp(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Hub exited before startup:\n${output.join('')}`)
    try {
      const response = await fetch(`${baseUrl}/login`)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for Hub startup:\n${output.join('')}`)
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || ''
  return raw.split(';', 1)[0]
}

async function emptyBucket(s3) {
  let continuationToken
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: s3Bucket, ContinuationToken: continuationToken }))
    const keys = (page.Contents || []).flatMap(item => item.Key ? [item.Key] : [])
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: s3Bucket,
        Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true }
      }))
    }
    continuationToken = page.NextContinuationToken
  } while (continuationToken)
}

async function responseJson(response) {
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status}: ${text}`)
  return body
}

async function main() {
  const adminDb = postgres(databaseAdminUrl, { max: 1 })
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey }
  })
  const primaryState = { captures: [], nonStreamChat: 0, streamChat: 0, responses: 0, imageEdits: 0, imageGenerations: 0, embeddings: 0, primaryChatHealthy: false, nonStreamBodyFailure: false, imageNetworkFailure: false, embeddingDelayMs: 300 }
  const fallbackState = { captures: [], nonStreamChat: 0, streamChat: 0, responses: 0, imageEdits: 0, imageGenerations: 0, embeddings: 0 }
  const primary = createUpstream('primary', primaryState)
  const fallback = createUpstream('fallback', fallbackState)
  const alertDeliveries = []
  const alertReceiver = createServer(async (request, response) => {
    const body = await readBody(request)
    alertDeliveries.push({ body, signature: request.headers['x-zephyr-signature'] || '' })
    response.writeHead(204)
    response.end()
  })
  let appDb
  let child
  let objectKeys = []

  try {
    await adminDb.unsafe(`drop database if exists "${databaseName}" with (force)`)
    await adminDb.unsafe(`create database "${databaseName}"`)
    await redis.flushdb()
    await s3.send(new CreateBucketCommand({ Bucket: s3Bucket })).catch((error) => {
      if (error?.$metadata?.httpStatusCode !== 409) throw error
    })
    await emptyBucket(s3)

    const migration = spawnSync('npm', ['run', 'db:migrate'], {
      cwd: process.cwd(),
      env: { ...process.env, NUXT_DATABASE_URL: databaseUrl },
      encoding: 'utf8'
    })
    if (migration.status !== 0) throw new Error(`Migration failed:\n${migration.stdout}\n${migration.stderr}`)
    appDb = postgres(databaseUrl, { max: 2 })

    const primaryUrl = await listen(primary)
    const fallbackUrl = await listen(fallback)
    const alertWebhookUrl = await listen(alertReceiver)
    const probe = createServer()
    const appProbeUrl = await listen(probe)
    const appPort = new URL(appProbeUrl).port
    await new Promise(resolve => probe.close(resolve))
    const appUrl = `http://127.0.0.1:${appPort}`
    const appOutput = []
    child = spawn('node', ['.output/server/index.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: appPort,
        HOST: '127.0.0.1',
        NODE_ENV: 'development',
        NUXT_DATABASE_URL: databaseUrl,
        NUXT_REDIS_URL: redisUrl,
        NUXT_ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
        NUXT_HUB_KEY_PEPPER: 'hub-e2e-pepper-2026-at-least-thirty-two',
        NUXT_HUB_KEY_ENCRYPTION_ACTIVE_VERSION: 'v1',
        NUXT_HUB_KEY_ENCRYPTION_KEYS: '{"v1":"CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg="}',
        NUXT_ADMIN_USERNAME: adminUsername,
        NUXT_ADMIN_PASSWORD: adminPassword,
        NUXT_S3_ENDPOINT: s3Endpoint,
        NUXT_S3_REGION: 'us-east-1',
        NUXT_S3_BUCKET: s3Bucket,
        NUXT_S3_ACCESS_KEY_ID: s3AccessKeyId,
        NUXT_S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
        NUXT_S3_FORCE_PATH_STYLE: 'true',
        NUXT_METRICS_TOKEN: 'hub-e2e-metrics-token',
        NUXT_OPERATIONS_TOKEN: 'hub-e2e-operations-token-at-least-32-characters',
        NUXT_ALERT_WEBHOOK_URL: alertWebhookUrl,
        NUXT_ALERT_WEBHOOK_SECRET: 'hub-e2e-alert-secret',
        NUXT_ALERT_MINIMUM_REQUESTS: '100000',
        NUXT_ALERT_MEMORY_RSS_BYTES: '9999999999'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => appOutput.push(chunk.toString()))
    child.stderr.on('data', chunk => appOutput.push(chunk.toString()))
    await waitForApp(appUrl, child, appOutput)
    const health = await fetch(`${appUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })

    const login = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: adminUsername, password: adminPassword })
    })
    assert.equal(login.status, 200)
    const cookie = cookieFrom(login)
    assert.match(cookie, /^zephyr_session=/)

    assert.equal((await fetch(`${appUrl}/api/metrics`)).status, 401)
    const metrics = await fetch(`${appUrl}/api/metrics`, { headers: { authorization: 'Bearer hub-e2e-metrics-token' } })
    assert.equal(metrics.status, 200)
    assert.match(await metrics.text(), /zephyr_hub_requests_total/)

    const adminRequest = async (path, options = {}) => {
      const response = await fetch(`${appUrl}${path}`, {
        ...options,
        headers: {
          cookie,
          origin: appUrl,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers
        }
      })
      return { response, body: await responseJson(response) }
    }

    const receiverId = '00000000-0000-4000-8000-000000000101'
    const purchasedAccountA = '00000000-0000-4000-8000-000000000102'
    const purchasedAccountB = '00000000-0000-4000-8000-000000000103'
    await appDb`
      insert into sms_receivers (id, phone, phone_key, provider_host, encrypted_fetch_url)
      values (${receiverId}, ${'+86 138 0013 8000'}, ${'8613800138000'}, ${'sms.example.com'}, ${'encrypted-e2e-value'})
    `
    await appDb`
      insert into account_vault_entries (id, email, display_name, encrypted_password)
      values
        (${purchasedAccountA}, ${'deleted-account@example.com'}, ${'Deleted Account'}, ${'encrypted-e2e-value'}),
        (${purchasedAccountB}, ${'active-account@example.com'}, ${'Active Account'}, ${'encrypted-e2e-value'})
    `
    await appDb`
      insert into sms_receiver_bindings (receiver_id, account_id, account_email, account_display_name, slot)
      values
        (${receiverId}, ${purchasedAccountA}, ${'deleted-account@example.com'}, ${'Deleted Account'}, ${1}),
        (${receiverId}, ${purchasedAccountB}, ${'active-account@example.com'}, ${'Active Account'}, ${2})
    `
    await adminRequest(`/api/admin/account-vault/${purchasedAccountA}`, { method: 'DELETE' })
    const receiversAfterAccountDeletion = (await adminRequest('/api/admin/sms-receivers')).body.items
    const retainedReceiver = receiversAfterAccountDeletion.find(item => item.id === receiverId)
    assert.equal(retainedReceiver.bindingCount, 2, 'deleting a purchased account must not release its SMS receiver slot')
    assert.equal(retainedReceiver.availableSlots, 1)
    assert.deepEqual(retainedReceiver.accounts.map(item => [item.slot, item.deleted]), [[1, true], [2, false]])
    const deletedBinding = retainedReceiver.accounts.find(item => item.deleted)
    assert.ok(deletedBinding?.bindingId)
    const bindingRemoval = await adminRequest(`/api/admin/sms-receivers/${receiverId}/bindings/${deletedBinding.bindingId}`, { method: 'DELETE' })
    assert.equal(bindingRemoval.response.status, 200)
    const receiverAfterBindingRemoval = (await adminRequest('/api/admin/sms-receivers')).body.items.find(item => item.id === receiverId)
    assert.equal(receiverAfterBindingRemoval.bindingCount, 1, 'manually removing a retained binding must release one SMS slot')
    assert.equal(receiverAfterBindingRemoval.availableSlots, 2)
    assert.equal((await appDb`select count(*)::int as count from account_vault_entries where id = ${purchasedAccountB}`)[0].count, 1, 'binding removal must not delete the active account')

    assert.equal((await adminRequest('/api/admin/alerts/test', { method: 'POST' })).body.delivered, true)
    assert.equal(alertDeliveries.length, 1)
    const alertBody = alertDeliveries[0].body.toString()
    assert.equal(alertDeliveries[0].signature, `sha256=${createHmac('sha256', 'hub-e2e-alert-secret').update(alertBody).digest('hex')}`)
    assert.equal(JSON.parse(alertBody).status, 'test')

    for (const path of [
      '/api/admin/logs?from=not-a-date',
      '/api/admin/logs?keyId=not-a-uuid',
      '/api/admin/logs?status=unknown',
      '/api/admin/overview?range=unknown',
      '/api/admin/overview?range=custom&from=2026-01-01T00:00:00Z'
    ]) {
      const invalidFilter = await fetch(`${appUrl}${path}`, { headers: { cookie } })
      assert.equal(invalidFilter.status, 400, `${path} should be rejected`)
      await invalidFilter.arrayBuffer()
    }

    await appDb.unsafe(`
      create function e2e_reject_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'key.create' and new.detail->>'name' = 'Rollback E2E' then
          raise exception 'injected audit failure';
        end if;
        return new;
      end $$;
      create trigger e2e_reject_audit before insert on audit_logs
      for each row execute function e2e_reject_audit();
    `)
    const rolledBackKey = await fetch(`${appUrl}/api/admin/keys`, {
      method: 'POST',
      headers: { cookie, origin: appUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rollback E2E' })
    })
    assert.equal(rolledBackKey.status, 500)
    await rolledBackKey.arrayBuffer()
    const [rolledBackKeyCount] = await appDb`select count(*)::int as count from hub_keys where name = 'Rollback E2E'`
    assert.equal(rolledBackKeyCount.count, 0, 'business mutation must roll back when its audit insert fails')
    await appDb.unsafe('drop trigger e2e_reject_audit on audit_logs; drop function e2e_reject_audit()')

    const routedEndpoints = ['/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/images/generations', '/v1/images/edits']
    const createChannel = async (name, type, baseUrl, apiKey, priority) => (await adminRequest('/api/admin/channels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        type,
        baseUrl,
        apiKey,
        priority,
        weight: 1,
        maxConcurrency: 10,
        timeoutMs: 5000,
        models: [
          { publicModel: 'hub-test', upstreamModel: `upstream-${name}`, enabled: true, endpoints: routedEndpoints },
          { publicModel: `shadow-${name}`, upstreamModel: `upstream-${name}`, enabled: true, endpoints: routedEndpoints }
        ]
      })
    })).body

    const primaryChannel = await createChannel('primary', 'cpa', primaryUrl, 'primary-upstream-secret', 1)
    const fallbackChannel = await createChannel('fallback', 'sub2api', fallbackUrl, 'fallback-upstream-secret', 2)
    assert.equal((await adminRequest(`/api/admin/channels/${primaryChannel.id}/test`, { method: 'POST' })).body.healthy, true)
    assert.equal((await adminRequest(`/api/admin/channels/${fallbackChannel.id}/test`, { method: 'POST' })).body.healthy, true)

    const defaultGroup = (await adminRequest('/api/admin/groups')).body.groups.find(group => group.name === '默认分组')
    assert(defaultGroup, 'fresh initial administrator must have a default group')
    assert.equal(defaultGroup.userIds.length, 1)
    const configuredGroup = (await adminRequest(`/api/admin/groups/${defaultGroup.id}/channels`, {
      method: 'PUT',
      body: JSON.stringify({ channelRules: [
        { channelId: primaryChannel.id, enabled: true, priorityOverride: 7, weightOverride: 4 },
        { channelId: fallbackChannel.id, enabled: false, priorityOverride: null, weightOverride: null }
      ] })
    })).body.group
    assert.deepEqual(configuredGroup.channelRules.map(rule => [rule.channelId, rule.enabled, rule.priorityOverride, rule.weightOverride]), [
      [primaryChannel.id, true, 7, 4],
      [fallbackChannel.id, false, null, null]
    ])
    await adminRequest(`/api/admin/groups/${defaultGroup.id}/channels`, { method: 'PUT', body: JSON.stringify({ channelRules: [] }) })

    const tenantGroup = (await adminRequest('/api/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'Tenant E2E', allowedEndpoints: ['/v1/models'], models: ['hub-test'], channelRules: [{ channelId: primaryChannel.id, enabled: true, priorityOverride: null, weightOverride: null }] })
    })).body.group
    const tenantPassword = 'tenant-e2e-password-2026'
    const tenantUser = (await adminRequest('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'tenant-e2e-user', displayName: 'Tenant E2E User', password: tenantPassword, role: 'user', mustChangePassword: false, groupIds: [tenantGroup.id] })
    })).body.user
    assert.deepEqual(tenantUser.groupIds, [defaultGroup.id], 'ordinary users must remain in the default group')
    const tenantKey = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Tenant E2E Key', ownerUserId: tenantUser.id, groupId: defaultGroup.id, allowedEndpoints: ['/v1/models'], allowedModels: ['hub-test'] })
    })).body
    const tenantLogin = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: tenantUser.username, password: tenantPassword })
    })
    assert.equal(tenantLogin.status, 200)
    const tenantCookie = cookieFrom(tenantLogin)
    assert.match(tenantCookie, /^zephyr_session=/)
    const tenantRequest = path => fetch(`${appUrl}${path}`, { headers: { cookie: tenantCookie } })
    for (const path of ['/api/console/overview', '/api/console/keys', '/api/console/usage', '/api/console/groups', '/api/console/models', '/api/console/logs']) {
      assert.equal((await tenantRequest(path)).status, 200, `${path} must be available to the owning user`)
    }
    const tenantReveal = await fetch(`${appUrl}/api/console/keys/${tenantKey.item.id}/reveal`, { method: 'POST', headers: { cookie: tenantCookie, origin: appUrl } })
    assert.equal(tenantReveal.status, 200)
    assert.equal((await tenantReveal.json()).key, tenantKey.key)
    assert.match(tenantReveal.headers.get('cache-control') || '', /no-store/)
    const tenantSecretEdit = await fetch(`${appUrl}/api/console/keys/${tenantKey.item.id}`, {
      method: 'PATCH', headers: { cookie: tenantCookie, origin: appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'forbidden-replacement-value' })
    })
    assert.equal(tenantSecretEdit.status, 400)
    const protectedMembership = await fetch(`${appUrl}/api/admin/users/${tenantUser.id}/groups`, {
      method: 'PUT', headers: { cookie, origin: appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ groupIds: [tenantGroup.id] })
    })
    assert.equal(protectedMembership.status, 200)
    assert.deepEqual((await protectedMembership.json()).user.groupIds, [defaultGroup.id])
    await adminRequest(`/api/admin/groups/${defaultGroup.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) })
    assert.equal((await fetch(`${appUrl}/v1/models`, { headers: { authorization: `Bearer ${tenantKey.key}` } })).status, 401)
    await adminRequest(`/api/admin/groups/${defaultGroup.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) })
    assert.equal((await fetch(`${appUrl}/v1/models`, { headers: { authorization: `Bearer ${tenantKey.key}` } })).status, 200)
    await adminRequest(`/api/admin/keys/${tenantKey.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ allowedEndpoints: ['/v1/models', '/v1/chat/completions'] })
    })
    const tokenPlan = (await adminRequest('/api/admin/plans', {
      method: 'POST',
      body: JSON.stringify({ name: 'E2E Token 周卡', mode: 'token', cycle: 'week', tokenLimit: 1, price: 1 })
    })).body.plan
    await adminRequest('/api/admin/plans/assign', {
      method: 'POST',
      body: JSON.stringify({ userId: tenantUser.id, planId: tokenPlan.id })
    })
    const planDenied = await fetch(`${appUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', messages: [{ role: 'user', content: 'quota check' }], max_tokens: 1 })
    })
    assert.equal(planDenied.status, 429)
    assert.match((await planDenied.json()).error.message, /当前套餐Token 额度已用尽/)
    await fetch(`${appUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: tenantCookie, origin: appUrl } })
    await adminRequest(`/api/admin/keys/${tenantKey.item.id}`, { method: 'DELETE' })
    await adminRequest(`/api/admin/users/${tenantUser.id}`, { method: 'DELETE' })
    await adminRequest(`/api/admin/plans/${tokenPlan.id}`, { method: 'DELETE' })
    await adminRequest(`/api/admin/groups/${tenantGroup.id}`, { method: 'DELETE' })

    primaryState.primaryChatHealthy = true
    const shadowValidation = spawn('node', ['tests/hub-shadow.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUB_SHADOW_URL: appUrl,
        HUB_SHADOW_ADMIN_USERNAME: adminUsername,
        HUB_SHADOW_ADMIN_PASSWORD: adminPassword,
        HUB_SHADOW_CPA_CHANNEL_ID: primaryChannel.id,
        HUB_SHADOW_SUB2API_CHANNEL_ID: fallbackChannel.id,
        HUB_SHADOW_CPA_MODEL: 'shadow-primary',
        HUB_SHADOW_SUB2API_MODEL: 'shadow-fallback',
        HUB_SHADOW_RUN_REQUESTS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const shadowOutput = []
    shadowValidation.stdout.on('data', chunk => shadowOutput.push(chunk.toString()))
    shadowValidation.stderr.on('data', chunk => shadowOutput.push(chunk.toString()))
    const [shadowExitCode] = await once(shadowValidation, 'exit')
    assert.equal(shadowExitCode, 0, shadowOutput.join(''))
    assert.match(shadowOutput.join(''), /"passed":true/)
    const loginRateKeys = await redis.keys('hub:rate-limit:login:*')
    if (loginRateKeys.length) await redis.del(...loginRateKeys)
    const failedLoginStatuses = []
    for (let index = 0; index < 9; index++) {
      const failedLogin = await fetch(`${appUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${index + 1}` },
        body: JSON.stringify({ username: adminUsername, password: 'wrong-password' })
      })
      failedLoginStatuses.push(failedLogin.status)
      if (index === 8) assert(Number(failedLogin.headers.get('retry-after')) > 0)
      await failedLogin.arrayBuffer()
    }
    assert.deepEqual(failedLoginStatuses, [401, 401, 401, 401, 401, 401, 401, 401, 429])
    primaryState.primaryChatHealthy = false
    primaryState.nonStreamChat = 0
    fallbackState.nonStreamChat = 0
    primaryState.captures = []
    fallbackState.captures = []

    const edgeProbeKey = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Edge Probe E2E',
        allowedModels: ['hub-test'],
        allowedEndpoints: ['/v1/models', '/v1/responses', '/v1/chat/completions'],
        rpmLimit: 100,
        concurrencyLimit: 5
      })
    })).body
    const edgeProbe = spawn('node', ['deploy/edge/probe.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EDGE_PROBE_URL: appUrl,
        EDGE_PROBE_HUB_KEY: edgeProbeKey.key,
        EDGE_PROBE_MODEL: 'hub-test',
        EDGE_PROBE_CONCURRENCY: '3'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const edgeProbeOutput = []
    edgeProbe.stdout.on('data', chunk => edgeProbeOutput.push(chunk.toString()))
    edgeProbe.stderr.on('data', chunk => edgeProbeOutput.push(chunk.toString()))
    const [edgeProbeExitCode] = await once(edgeProbe, 'exit')
    assert.equal(edgeProbeExitCode, 0, edgeProbeOutput.join(''))
    assert.equal(JSON.parse(edgeProbeOutput.join('')).passed, true)
    assert.equal(edgeProbeOutput.join('').includes(edgeProbeKey.key), false)
    primaryState.nonStreamBodyFailure = true
    const fallbackBeforeBodyFailure = fallbackState.nonStreamChat
    const interruptedBody = await fetch(`${appUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${edgeProbeKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', messages: [{ role: 'user', content: 'interrupt after headers' }] })
    })
    assert.equal(interruptedBody.status, 502)
    assert.equal(fallbackState.nonStreamChat, fallbackBeforeBodyFailure, 'body interruption after upstream headers must not fail over')
    primaryState.nonStreamBodyFailure = false
    const temporaryCircuitKeys = await redis.keys(`hub:circuit:${primaryChannel.id}:*`)
    if (temporaryCircuitKeys.length) await redis.del(...temporaryCircuitKeys)
    await adminRequest(`/api/admin/keys/${edgeProbeKey.item.id}`, { method: 'DELETE' })
    primaryState.nonStreamChat = 0
    fallbackState.nonStreamChat = 0
    primaryState.responses = 0
    fallbackState.responses = 0

    const keyResult = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Hub E2E',
        allowedModels: ['hub-test'],
        allowedEndpoints: ['/v1/models', ...routedEndpoints],
        rpmLimit: 100,
        concurrencyLimit: 1,
        totalRequestLimit: 100
      })
    })).body
    const hubKey = keyResult.key
    const gateway = (path, options = {}) => fetch(`${appUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${hubKey}`, ...options.headers }
    })

    const rotationSeed = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Rotation E2E', allowedModels: ['hub-test'], allowedEndpoints: ['/v1/models'] })
    })).body
    const rotated = (await adminRequest(`/api/admin/keys/${rotationSeed.item.id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ graceSeconds: 3600 })
    })).body
    const rotatedGateway = key => fetch(`${appUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal((await rotatedGateway(rotationSeed.key)).status, 200, 'old credential must remain valid during rotation grace')
    assert.equal((await rotatedGateway(rotated.key)).status, 200)
    assert.equal((await fetch(`${appUrl}/api/operations/traffic`)).status, 401)
    const draining = (await adminRequest('/api/admin/traffic', { method: 'POST', body: JSON.stringify({ enabled: true, ttlSeconds: 300, reason: 'E2E drain' }) })).body
    assert.equal(draining.enabled, true)
    assert.equal((await fetch(`${appUrl}/api/ready`)).status, 503)
    const drainedRequest = await rotatedGateway(rotated.key)
    assert.equal(drainedRequest.status, 503)
    assert.equal((await drainedRequest.json()).error.code, 'gateway_draining')
    const resumeTraffic = await fetch(`${appUrl}/api/operations/traffic`, {
      method: 'POST',
      headers: { authorization: 'Bearer hub-e2e-operations-token-at-least-32-characters', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    })
    assert.equal(resumeTraffic.status, 200)
    assert.equal((await resumeTraffic.json()).enabled, false)
    assert.equal((await fetch(`${appUrl}/api/ready`)).status, 200)
    const rotationDetail = (await adminRequest(`/api/admin/keys/${rotationSeed.item.id}`)).body
    const oldCredential = rotationDetail.credentials.find(item => !item.current)
    assert(oldCredential)
    await adminRequest(`/api/admin/keys/${rotationSeed.item.id}/credentials/${oldCredential.id}`, { method: 'DELETE' })
    assert.equal((await rotatedGateway(rotationSeed.key)).status, 401)
    assert.equal((await rotatedGateway(rotated.key)).status, 200)
    await adminRequest(`/api/admin/keys/${rotationSeed.item.id}`, { method: 'DELETE' })

    const models = await gateway('/v1/models')
    assert.equal(models.status, 200)
    assert.deepEqual((await models.json()).data.map(item => item.id), ['hub-test'])

    const failover = await gateway('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        forwarded: 'for=198.51.100.9',
        'x-forwarded-for': '198.51.100.9',
        'x-real-ip': '198.51.100.9'
      },
      body: JSON.stringify({
        model: 'hub-test',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { Authorization: 'archive-client-secret', Cookie: 'archive-cookie-secret' }
      })
    })
    assert.equal(failover.status, 200)
    assert.match(failover.headers.get('x-request-id') || '', /^req_[a-f0-9]{32}$/)
    assert.equal((await failover.json()).source, 'fallback')
    assert.equal(primaryState.nonStreamChat, 1)
    assert.equal(fallbackState.nonStreamChat, 1)
    assert.equal(JSON.parse(primaryState.captures.at(-1).body).model, 'upstream-primary')
    assert.equal(JSON.parse(fallbackState.captures.at(-1).body).model, 'upstream-fallback')
    assert.equal(fallbackState.captures.at(-1).authorization, 'Bearer fallback-upstream-secret')
    assert.equal(fallbackState.captures.at(-1).forwarded, '')
    assert.equal(fallbackState.captures.at(-1).forwardedFor, '')
    assert.equal(fallbackState.captures.at(-1).realIp, '')
    assert.equal(fallbackState.captures.at(-1).body.includes(Buffer.from(hubKey)), false)

    const failoverId = failover.headers.get('x-request-id')
    const failoverLogs = (await adminRequest(`/api/admin/logs?search=${failoverId}`)).body
    assert.equal(failoverLogs.total, 1)
    const failoverDetail = (await adminRequest(`/api/admin/logs/${failoverLogs.items[0].id}`)).body
    assert.equal(failoverDetail.failoverCount, 1)
    assert.deepEqual(failoverDetail.attempts.map(item => [item.status, item.httpStatus]), [['failed', 503], ['success', 200]])
    assert.equal(failoverDetail.requestBodyHash, createHash('sha256').update(failoverDetail.requestBody.content).digest('hex'))
    assert.equal(failoverDetail.requestBody.content.includes('archive-client-secret'), false)
    assert.equal(failoverDetail.requestBody.content.includes('archive-cookie-secret'), false)
    assert.match(failoverDetail.requestBody.content, /\[REDACTED\]/)

    const aborted = await gateway('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', stream: true, messages: [{ role: 'user', content: 'abort' }] })
    })
    assert.equal(aborted.status, 200)
    assert.match(await aborted.text(), /partial/)
    await delay(100)
    assert.equal(primaryState.streamChat, 1)
    assert.equal(fallbackState.nonStreamChat, 1, 'streaming must not fail over after the first response bytes')
    const abortedLogs = (await adminRequest(`/api/admin/logs?search=${aborted.headers.get('x-request-id')}`)).body
    assert.equal(abortedLogs.items[0].status, 'stream_aborted')

    const streamStarted = Date.now()
    const responses = await gateway('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', stream: true, input: 'hello' })
    })
    assert.equal(responses.status, 200)
    const reader = responses.body.getReader()
    const first = await reader.read()
    const firstByteMs = Date.now() - streamStarted
    assert.equal(first.done, false)
    assert(firstByteMs < 250, `first SSE chunk was buffered for ${firstByteMs}ms`)
    const chunks = [Buffer.from(first.value)]
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(Buffer.from(next.value))
    }
    const streamed = Buffer.concat(chunks).toString('utf8')
    assert.match(streamed, /event: response\.output_text\.delta/)
    assert.match(streamed, /event: response\.completed/)
    assert.equal(primaryState.responses, 1)
    assert.equal(fallbackState.responses, 0)

    let responseLog
    for (let attempt = 0; attempt < 20 && responseLog?.firstByteMs == null; attempt++) {
      await delay(50)
      responseLog = (await adminRequest(`/api/admin/logs?search=${responses.headers.get('x-request-id')}`)).body.items[0]
    }
    assert(responseLog.firstByteMs >= 100 && responseLog.firstByteMs < 300, `recorded first body byte was ${responseLog.firstByteMs}ms`)

    await adminRequest(`/api/admin/channels/${primaryChannel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ timeoutMs: 1000 })
    })
    const longStream = await gateway('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', stream: true, input: 'long active stream' })
    })
    assert.equal(longStream.status, 200)
    assert.match(await longStream.text(), /response\.completed/, 'active SSE must not use the channel timeout as a total lifetime limit')

    const canceledStream = await gateway('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', stream: true, input: 'client abort' })
    })
    const canceledReader = canceledStream.body.getReader()
    assert.equal((await canceledReader.read()).done, false)
    await canceledReader.cancel()
    for (let attempt = 0; attempt < 30; attempt++) {
      const [keyLeases, groupLeases, channelLeases] = await Promise.all([
        redis.zcard(`hub:key:${keyResult.item.id}:concurrency:leases`),
        redis.zcard(`hub:group:${defaultGroup.id}:concurrency:leases`),
        redis.zcard(`hub:channel:${primaryChannel.id}:concurrency:leases`)
      ])
      if (keyLeases === 0 && groupLeases === 0 && channelLeases === 0) break
      await delay(50)
    }
    assert.equal(await redis.zcard(`hub:key:${keyResult.item.id}:concurrency:leases`), 0, 'client abort must release the Hub Key lease')
    assert.equal(await redis.zcard(`hub:group:${defaultGroup.id}:concurrency:leases`), 0, 'client abort must release the group lease')
    assert.equal(await redis.zcard(`hub:channel:${primaryChannel.id}:concurrency:leases`), 0, 'client abort must release the channel lease')
    await adminRequest(`/api/admin/channels/${primaryChannel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ timeoutMs: 5000 })
    })

    await adminRequest('/api/admin/models/hub-test', {
      method: 'PUT',
      body: JSON.stringify({
        strategy: 'priority',
        enabled: true,
        price: { imagePrices: { '1024x1024:auto': 1, '1024x1024:high': 2 } }
      })
    })

    const form = new FormData()
    form.set('image', new Blob([imageBytes], { type: 'image/png' }), 'binary.png')
    form.set('model', 'hub-test')
    form.set('size', '1024x1024')
    form.set('quality', 'high')
    form.set('n', '1')
    const image = await gateway('/v1/images/edits', { method: 'POST', body: form })
    assert.equal(image.status, 200)
    const imageRequestId = image.headers.get('x-request-id')
    assert.equal((await image.json()).data.length, 1)
    assert(primaryState.multipart.contentType.startsWith('multipart/form-data; boundary='))
    assert(primaryState.multipart.body.includes(imageBytes), 'multipart image bytes changed in transit')
    assert(primaryState.multipart.body.includes(Buffer.from('\r\n\r\nupstream-primary\r\n')))
    assert.equal(primaryState.multipart.authorization, 'Bearer primary-upstream-secret')
    const pricedImageLog = (await adminRequest(`/api/admin/logs?search=${imageRequestId}`)).body.items[0]
    assert.equal(pricedImageLog.cost, 2, 'multipart image quality and size must determine final cost')

    const generated = await gateway('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', prompt: 'generated test image', size: '1024x1024' })
    })
    assert.equal(generated.status, 200)
    assert.equal((await generated.json()).data[0].b64_json, 'Z2VuZXJhdGVk')
    assert.equal(primaryState.imageGenerations, 1)

    const largeImageBytes = Buffer.alloc(6 * 1024 * 1024, 0x5a)
    Buffer.from('large-image-start').copy(largeImageBytes, 0)
    Buffer.from('large-image-end').copy(largeImageBytes, largeImageBytes.length - 'large-image-end'.length)
    const largeForm = new FormData()
    largeForm.set('model', 'hub-test')
    largeForm.set('image', new Blob([largeImageBytes], { type: 'image/png' }), 'large.png')
    const largeImage = await gateway('/v1/images/edits', { method: 'POST', body: largeForm })
    assert.equal(largeImage.status, 200)
    await largeImage.arrayBuffer()
    assert(primaryState.multipart.body.includes(Buffer.from('large-image-start')))
    assert(primaryState.multipart.body.includes(Buffer.from('large-image-end')))

    const imageEditsBeforeOversize = primaryState.imageEdits
    const oversizedForm = new FormData()
    oversizedForm.set('model', 'hub-test')
    oversizedForm.set('image', new Blob([Buffer.alloc(50 * 1024 * 1024 + 1024)], { type: 'image/png' }), 'oversized.png')
    const oversized = await gateway('/v1/images/edits', { method: 'POST', body: oversizedForm })
    assert.equal(oversized.status, 413)
    assert.equal(primaryState.imageEdits, imageEditsBeforeOversize, 'oversized multipart body reached the upstream')

    primaryState.imageNetworkFailure = true
    const failedForm = new FormData()
    failedForm.set('model', 'hub-test')
    failedForm.set('image', new Blob([imageBytes], { type: 'image/png' }), 'uncertain.png')
    const failedImage = await gateway('/v1/images/edits', { method: 'POST', body: failedForm })
    assert.equal(failedImage.status, 502)
    assert.equal((await failedImage.json()).error.code, 'upstream_error')
    assert.equal(fallbackState.imageEdits, 0, 'ambiguous image failures must not be retried')
    primaryState.imageNetworkFailure = false

    const idempotencyKey = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Idempotency E2E', allowedModels: ['hub-test'], allowedEndpoints: ['/v1/images/generations'], rpmLimit: 20, concurrencyLimit: 2 })
    })).body
    const idempotentGateway = body => fetch(`${appUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${idempotencyKey.key}`, 'content-type': 'application/json', 'idempotency-key': 'image-job-1' },
      body: JSON.stringify(body)
    })
    const imageGenerationsBeforeIdempotency = primaryState.imageGenerations
    const idempotentFirst = await idempotentGateway({ model: 'hub-test', prompt: 'idempotent image', size: '1024x1024' })
    assert.equal(idempotentFirst.status, 200)
    const idempotentBody = await idempotentFirst.text()
    const idempotentReplay = await idempotentGateway({ model: 'hub-test', prompt: 'idempotent image', size: '1024x1024' })
    assert.equal(idempotentReplay.status, 200)
    assert.equal(idempotentReplay.headers.get('x-idempotent-replayed'), 'true')
    assert.equal(await idempotentReplay.text(), idempotentBody)
    assert.equal(primaryState.imageGenerations, imageGenerationsBeforeIdempotency + 1, 'idempotent replay must not call upstream twice')
    const idempotencyConflict = await idempotentGateway({ model: 'hub-test', prompt: 'different image', size: '1024x1024' })
    assert.equal(idempotencyConflict.status, 409)
    assert.equal((await idempotencyConflict.json()).error.code, 'idempotency_key_reused')
    await adminRequest(`/api/admin/keys/${idempotencyKey.item.id}`, { method: 'DELETE' })

    const protectedKey = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Request Protection E2E', allowedModels: ['hub-test'],
        allowedEndpoints: ['/v1/chat/completions', '/v1/images/generations'],
        maxRequestTokens: 10, maxRequestCost: 1, maxImageCount: 1, allowedImageSizes: ['1024x1024'], allowedImageQualities: ['auto', 'high']
      })
    })).body
    const protectedChat = await fetch(`${appUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${protectedKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', max_tokens: 20, messages: [{ role: 'user', content: 'blocked' }] })
    })
    assert.equal(protectedChat.status, 400)
    assert.equal((await protectedChat.json()).error.code, 'request_token_limit')
    const protectedImage = await fetch(`${appUrl}/v1/images/generations`, {
      method: 'POST', headers: { authorization: `Bearer ${protectedKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', prompt: 'blocked', n: 2, size: '1024x1024', quality: 'auto' })
    })
    assert.equal(protectedImage.status, 400)
    assert.equal((await protectedImage.json()).error.code, 'request_image_limit')
    const protectedCost = await fetch(`${appUrl}/v1/images/generations`, {
      method: 'POST', headers: { authorization: `Bearer ${protectedKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', prompt: 'blocked by cost', n: 1, size: '1024x1024', quality: 'high' })
    })
    assert.equal(protectedCost.status, 400)
    assert.equal((await protectedCost.json()).error.code, 'request_cost_limit')
    await adminRequest(`/api/admin/keys/${protectedKey.item.id}`, { method: 'DELETE' })

    let resolveEmbeddingStarted
    const embeddingStarted = new Promise(resolve => { resolveEmbeddingStarted = resolve })
    primaryState.resolveEmbeddingStarted = resolveEmbeddingStarted
    const firstEmbedding = gateway('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', input: 'one' })
    })
    await embeddingStarted
    const competingEmbeddings = await Promise.all(Array.from({ length: 12 }, (_, index) => gateway('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', input: `competing-${index}` })
    })))
    assert(competingEmbeddings.every(response => response.status === 429))
    assert.equal((await competingEmbeddings[0].json()).error.code, 'rate_limit_exceeded')
    assert.equal((await firstEmbedding).status, 200)

    await adminRequest('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ circuitFailureThreshold: 2, circuitCooldownMs: 1000 })
    })
    const chat = async (content) => gateway('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', messages: [{ role: 'user', content }] })
    })
    const primaryBeforeCircuit = primaryState.nonStreamChat
    const fallbackBeforeCircuit = fallbackState.nonStreamChat
    assert.equal((await (await chat('circuit-1')).json()).source, 'fallback')
    assert.equal((await (await chat('circuit-2')).json()).source, 'fallback')
    assert.equal((await (await chat('circuit-open')).json()).source, 'fallback')
    assert.equal(primaryState.nonStreamChat - primaryBeforeCircuit, 2, 'open circuit must skip the primary channel')
    assert.equal(fallbackState.nonStreamChat - fallbackBeforeCircuit, 3)
    const openChannels = (await adminRequest('/api/admin/channels')).body.channels
    assert.equal(openChannels.find(item => item.id === primaryChannel.id).circuitState, 'open')
    assert.equal((await adminRequest('/api/admin/overview')).body.healthyChannels, 1)
    await delay(1100)
    const halfOpenChannels = (await adminRequest('/api/admin/channels')).body.channels
    assert.equal(halfOpenChannels.find(item => item.id === primaryChannel.id).circuitState, 'half_open')
    primaryState.primaryChatHealthy = true
    assert.equal((await (await chat('half-open-probe')).json()).source, 'primary')
    assert.equal((await (await chat('closed-again')).json()).source, 'primary')
    const recoveredChannels = (await adminRequest('/api/admin/channels')).body.channels
    assert.equal(recoveredChannels.find(item => item.id === primaryChannel.id).circuitState, 'closed')
    assert.equal((await adminRequest('/api/admin/overview')).body.healthyChannels, 2)

    await adminRequest(`/api/admin/channels/${fallbackChannel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ weight: 3 })
    })
    await adminRequest('/api/admin/models/hub-test', {
      method: 'PUT',
      body: JSON.stringify({ strategy: 'weighted_round_robin', enabled: true })
    })
    const primaryBeforeWeighted = primaryState.nonStreamChat
    const fallbackBeforeWeighted = fallbackState.nonStreamChat
    for (let index = 0; index < 4; index++) {
      assert.equal((await chat(`weighted-${index}`)).status, 200)
    }
    assert.equal(primaryState.nonStreamChat - primaryBeforeWeighted, 1)
    assert.equal(fallbackState.nonStreamChat - fallbackBeforeWeighted, 3)

    await adminRequest('/api/admin/models/hub-test', {
      method: 'PUT',
      body: JSON.stringify({ strategy: 'priority', enabled: true })
    })
    await adminRequest(`/api/admin/channels/${primaryChannel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ timeoutMs: 1000 })
    })
    primaryState.embeddingDelayMs = 1200
    const timeoutResponse = await gateway('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', input: 'timeout failover' })
    })
    assert.equal(timeoutResponse.status, 200)
    assert.equal((await timeoutResponse.json()).source, 'fallback')
    const timeoutLogs = (await adminRequest(`/api/admin/logs?search=${timeoutResponse.headers.get('x-request-id')}`)).body
    const timeoutDetail = (await adminRequest(`/api/admin/logs/${timeoutLogs.items[0].id}`)).body
    assert.deepEqual(timeoutDetail.attempts.map(item => item.status), ['failed', 'success'])

    const forbiddenModel = await gateway('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-allowed', messages: [{ role: 'user', content: 'denied' }] })
    })
    assert.equal(forbiddenModel.status, 403)
    assert.equal((await forbiddenModel.json()).error.code, 'model_not_allowed')

    const expiringKey = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Expiring E2E Key',
        expiresAt: new Date(Date.now() + 500).toISOString(),
        allowedEndpoints: ['/v1/models']
      })
    })).body.key
    await delay(600)
    const expired = await fetch(`${appUrl}/v1/models`, { headers: { authorization: `Bearer ${expiringKey}` } })
    assert.equal(expired.status, 401)
    assert.equal((await expired.json()).error.code, 'key_expired')

    const disabledResult = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Disabled E2E Key', allowedEndpoints: ['/v1/models'] })
    })).body
    await adminRequest(`/api/admin/keys/${disabledResult.item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' })
    })
    const disabled = await fetch(`${appUrl}/v1/models`, { headers: { authorization: `Bearer ${disabledResult.key}` } })
    assert.equal(disabled.status, 401)
    assert.equal((await disabled.json()).error.code, 'invalid_api_key')
    assert.equal((await adminRequest('/api/admin/overview')).body.activeKeys, 1)
    const reliability = (await adminRequest(`/api/admin/overview?keyId=${keyResult.item.id}`)).body.totals
    assert.equal(typeof reliability.p95FirstByteMs, 'number')
    assert(reliability.streamAbortRate > 0)

    const keyActivity = (await adminRequest('/api/admin/key-activity')).body
    const primaryActivity = keyActivity.keys.find(item => item.id === keyResult.item.id)
    const expiredActivity = keyActivity.keys.find(item => item.name === 'Expiring E2E Key')
    const disabledActivity = keyActivity.keys.find(item => item.id === disabledResult.item.id)
    assert.equal(keyActivity.keys.some(item => item.id === edgeProbeKey.item.id), false)
    const [deletedKeyHistory] = await appDb`select count(*)::int as count from request_logs where key_id is null`
    assert(deletedKeyHistory.count > 0, 'deleted Key request history should remain anonymous')
    const [expectedActivity] = await appDb`
      select count(*)::int as requests,
        count(*) filter (where status = 'success')::int as successes,
        count(*) filter (where status in ('error', 'stream_aborted'))::int as failures,
        count(*) filter (where status = 'pending')::int as pending
      from request_logs
      where key_id = ${keyResult.item.id}
        and endpoint != '/v1/models'
        and created_at >= ${new Date(keyActivity.from)}
        and created_at < ${new Date(keyActivity.to)}
    `
    assert(primaryActivity, 'active Key is missing from Key activity')
    assert.equal(primaryActivity.buckets.length, 24)
    assert.equal(primaryActivity.requests, expectedActivity.requests)
    assert.equal(primaryActivity.successes, expectedActivity.successes)
    assert.equal(primaryActivity.failures, expectedActivity.failures)
    assert.equal(primaryActivity.pending, expectedActivity.pending)
    assert.equal(primaryActivity.buckets.reduce((sum, bucket) => sum + bucket.requests, 0), primaryActivity.requests)
    assert.equal(expiredActivity.status, 'expired')
    assert.equal(expiredActivity.requests, 0, '/v1/models must not create Key activity')
    assert.equal(disabledActivity.status, 'disabled')
    assert.equal(disabledActivity.requests, 0)
    const activeBucket = primaryActivity.buckets.find(bucket => bucket.requests > 0)
    assert(activeBucket, 'expected an active hourly bucket')
    const drillDown = (await adminRequest(`/api/admin/logs?keyId=${keyResult.item.id}&from=${encodeURIComponent(new Date(activeBucket.timestamp).toISOString())}&to=${encodeURIComponent(new Date(activeBucket.timestamp + 3600_000).toISOString())}`)).body
    assert(drillDown.items.length > 0)
    assert(drillDown.items.every(item => item.keyId === keyResult.item.id && item.createdAt >= activeBucket.timestamp && item.createdAt < activeBucket.timestamp + 3600_000))

    const [secretRow] = await appDb`select encrypted_api_key from channels where id = ${primaryChannel.id}`
    assert.notEqual(secretRow.encrypted_api_key, 'primary-upstream-secret')
    assert.equal(secretRow.encrypted_api_key.includes('primary-upstream-secret'), false)
    const [keyRow] = await appDb`select key_hash, key_prefix, key_last_four from hub_keys where id = ${keyResult.item.id}`
    assert.notEqual(keyRow.key_hash, hubKey)
    assert.equal(JSON.stringify(keyRow).includes(hubKey), false)

    const archived = await appDb`
      select request_body_object, response_body_object
      from request_logs
      where request_body_object is not null or response_body_object is not null
    `
    objectKeys = archived.flatMap(row => [row.request_body_object, row.response_body_object]).filter(Boolean)
    assert(objectKeys.length >= 6, 'request and response bodies were not archived')
    const imageLog = (await adminRequest(`/api/admin/logs?endpoint=${encodeURIComponent('/v1/images/edits')}`)).body.items[0]
    const imageDetail = (await adminRequest(`/api/admin/logs/${imageLog.id}`)).body
    assert.equal(imageDetail.requestBody.encoding, 'base64')
    const archivedMultipart = Buffer.from(imageDetail.requestBody.content, 'base64')
    assert(archivedMultipart.includes(imageBytes), 'archived multipart body lost binary bytes')
    assert(archivedMultipart.includes(Buffer.from('\r\n\r\nhub-test\r\n')), 'archive must retain the public model request')
    const expiringObjects = [imageDetail.requestBodyObject, imageDetail.responseBodyObject].filter(Boolean)
    assert(expiringObjects.length > 0)
    await appDb`update request_logs set body_expires_at = now() - interval '1 second' where id = ${imageLog.id}`
    const maintenance = (await adminRequest('/api/admin/maintenance/run', { method: 'POST' })).body
    assert.equal(maintenance.bodyCleanupError, null)
    assert.equal(maintenance.bodyObjectsDeleted, expiringObjects.length)
    const [cleanedLog] = await appDb`select request_body_object, response_body_object from request_logs where id = ${imageLog.id}`
    assert.equal(cleanedLog.request_body_object, null)
    assert.equal(cleanedLog.response_body_object, null)
    for (const Key of expiringObjects) {
      await assert.rejects(() => s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key })))
    }
    const cleanedDetail = (await adminRequest(`/api/admin/logs/${imageLog.id}`)).body
    assert.equal(cleanedDetail.requestBody, null)
    assert.equal(cleanedDetail.responseBody, null)

    await adminRequest('/api/admin/maintenance/reconcile', { method: 'POST' })
    const admitted = Number(await redis.hget(`hub:key:${keyResult.item.id}:usage:total`, 'requests'))
    assert.equal(admitted, 21, 'rejected concurrency, permission and body-size requests must not consume request quota')
    const [rollup] = await appDb`
      select sum(requests)::int as requests, sum(admitted_requests)::int as admitted
      from usage_rollups where granularity = 'day' and key_id = ${keyResult.item.id}
    `
    assert.equal(rollup.requests, 35)
    assert.equal(rollup.admitted, 21)
    const keyUsage = (await adminRequest(`/api/admin/keys/${keyResult.item.id}`)).body.periods.find(item => item.id === 'all')
    assert.equal(keyUsage.requests, 35)
    assert.equal(keyUsage.admittedRequests, 21)

    await adminRequest(`/api/admin/channels/${primaryChannel.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ timeoutMs: 5000 })
    })
    primaryState.embeddingDelayMs = 100
    const createBurstKey = async (name, limits) => (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        name,
        allowedModels: ['hub-test'],
        allowedEndpoints: ['/v1/embeddings'],
        concurrencyLimit: 20,
        ...limits
      })
    })).body.key
    const embeddingBurst = async (key, label) => Promise.all(Array.from({ length: 20 }, (_, index) => fetch(`${appUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hub-test', input: `${label}-${index}` })
    })))

    const rpmKey = await createBurstKey('RPM Burst E2E', { rpmLimit: 3 })
    const rpmBurst = await embeddingBurst(rpmKey, 'rpm')
    assert.equal(rpmBurst.filter(response => response.status === 200).length, 3)
    assert.equal(rpmBurst.filter(response => response.status === 429).length, 17)

    const requestQuotaKey = await createBurstKey('Request Quota Burst E2E', { rpmLimit: 100, totalRequestLimit: 3 })
    const requestQuotaBurst = await embeddingBurst(requestQuotaKey, 'request-quota')
    assert.equal(requestQuotaBurst.filter(response => response.status === 200).length, 3)
    assert.equal(requestQuotaBurst.filter(response => response.status === 429).length, 17)

    await adminRequest('/api/admin/models/hub-test', {
      method: 'PUT',
      body: JSON.stringify({
        strategy: 'priority',
        enabled: true,
        price: { inputPerMillion: 1000000, outputPerMillion: 0, cachedPerMillion: 0, reasoningPerMillion: 0 }
      })
    })
    const costKey = await createBurstKey('Cost Reservation Burst E2E', { rpmLimit: 100, totalCostLimit: 25 })
    const costBurst = await embeddingBurst(costKey, 'cost')
    assert.equal(costBurst.filter(response => response.status === 200).length, 2)
    assert.equal(costBurst.filter(response => response.status === 429).length, 18)

    const analyticsKey = (await adminRequest('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Analytics Range E2E' })
    })).body.item
    const now = Date.now()
    const shanghaiOffset = 8 * 3600_000
    const dayMs = 24 * 3600_000
    const todayStart = Math.floor((now + shanghaiOffset) / dayMs) * dayMs - shanghaiOffset
    const historicalTimes = [todayStart - 1, todayStart + Math.max(1, Math.floor((now - todayStart) / 2))]
    await appDb`
      insert into request_logs (
        request_id, key_id, endpoint, requested_model, channel_id, status, http_status,
        total_tokens, cost, duration_ms, created_at, completed_at
      ) values
        ('req_analytics_previous_day', ${analyticsKey.id}, '/v1/embeddings', 'hub-test', ${primaryChannel.id}, 'success', 200, 10, 1, 100, ${new Date(historicalTimes[0])}, ${new Date(historicalTimes[0] + 100)}),
        ('req_analytics_today', ${analyticsKey.id}, '/v1/embeddings', 'hub-test', ${primaryChannel.id}, 'error', 500, 20, 2, 200, ${new Date(historicalTimes[1])}, ${new Date(historicalTimes[1] + 200)})
    `
    for (let index = 0; index < historicalTimes.length; index++) {
      const timestamp = historicalTimes[index]
      const bucketStart = new Date(Math.floor((timestamp + shanghaiOffset) / dayMs) * dayMs - shanghaiOffset)
      const success = index === 0
      await appDb`
        insert into usage_rollups (
          bucket_start, granularity, key_id, model, endpoint, status, channel_id,
          requests, admitted_requests, successes, failures, total_tokens, cost,
          duration_ms, latency_count, latency_le_100, latency_le_250
        ) values (
          ${bucketStart}, 'day', ${analyticsKey.id}, 'hub-test', '/v1/embeddings',
          ${success ? 'success' : 'error'}, ${primaryChannel.id}, 1, 1,
          ${success ? 1 : 0}, ${success ? 0 : 1}, ${success ? 10 : 20},
          ${success ? 1 : 2}, ${success ? 100 : 200}, 1, ${success ? 1 : 0}, 1
        )
      `
    }
    const analyticsOverview = async (range, extra = '') => (await adminRequest(
      `/api/admin/overview?keyId=${analyticsKey.id}&range=${range}${extra}`
    )).body
    const todayOverview = await analyticsOverview('today')
    const rollingOverview = await analyticsOverview('24h')
    assert.equal(todayOverview.totals.requests, 1)
    assert.equal(rollingOverview.totals.requests, 2)
    assert.equal(rollingOverview.totals.totalTokens, 30)
    assert.equal(rollingOverview.totals.cost, 3)
    for (const range of ['week', 'month', 'year']) {
      const overview = await analyticsOverview(range)
      const expected = historicalTimes.filter(timestamp => timestamp >= overview.range.from && timestamp <= overview.range.to).length
      assert.equal(overview.totals.requests, expected, `${range} range boundary mismatch`)
    }
    const custom = await analyticsOverview(
      'custom',
      `&from=${encodeURIComponent(new Date(historicalTimes[0] - 60_000).toISOString())}&to=${encodeURIComponent(new Date(historicalTimes[0] + 60_000).toISOString())}`
    )
    assert.equal(custom.totals.requests, 1)
    assert.equal(custom.totals.totalTokens, 10)
    const allTime = await analyticsOverview('all')
    assert.equal(allTime.totals.requests, 2)
    assert.equal(allTime.totals.totalTokens, 30)

    const oldBucket = new Date(todayStart - 400 * dayMs)
    await appDb`
      insert into usage_rollups (
        bucket_start, granularity, key_id, model, endpoint, status, channel_id,
        requests, admitted_requests, successes, failures, total_tokens, cost,
        duration_ms, latency_count, latency_le_250
      ) values (
        ${oldBucket}, 'day', ${analyticsKey.id}, 'hub-test', '/v1/embeddings', 'success', ${primaryChannel.id},
        7, 7, 7, 0, 70, 7, 700, 7, 7
      )
    `
    const retainedHistory = await analyticsOverview(
      'custom',
      `&from=${encodeURIComponent(oldBucket.toISOString())}&to=${encodeURIComponent(new Date(oldBucket.getTime() + dayMs - 1).toISOString())}`
    )
    assert.equal(retainedHistory.totals.requests, 7, 'historical custom ranges must use permanent daily rollups after metadata retention')

    const exportedJson = (await adminRequest(`/api/admin/exports/usage?format=json&keyId=${analyticsKey.id}&from=${encodeURIComponent(oldBucket.toISOString())}&to=${encodeURIComponent(new Date(oldBucket.getTime() + dayMs - 1).toISOString())}`)).body
    assert.equal(exportedJson.records.reduce((sum, row) => sum + row.requests, 0), 7)
    const exportedCsv = await fetch(`${appUrl}/api/admin/exports/usage?format=csv&keyId=${analyticsKey.id}`, { headers: { cookie } })
    assert.equal(exportedCsv.status, 200)
    assert.match(exportedCsv.headers.get('content-disposition') || '', /zephyr-usage-.*\.csv/)
    assert.match(await exportedCsv.text(), /admittedRequests/)
    const audits = (await adminRequest('/api/admin/audits?action=key.rotate')).body
    assert(audits.items.some(item => item.action === 'key.rotate'))

    await adminRequest(`/api/admin/channels/${primaryChannel.id}`, { method: 'DELETE' })
    await adminRequest(`/api/admin/channels/${fallbackChannel.id}`, { method: 'DELETE' })
    const channelsAfterDelete = (await adminRequest('/api/admin/channels')).body
    assert.equal(channelsAfterDelete.channels.length, 0)
    const allTimeAfterChannelDelete = await analyticsOverview('all')
    assert.equal(allTimeAfterChannelDelete.totals.requests, allTime.totals.requests + 7)
    assert.equal(allTimeAfterChannelDelete.totals.totalTokens, allTime.totals.totalTokens + 70)
    const applicationLogs = appOutput.join('')
    for (const secret of [hubKey, adminPassword, 'primary-upstream-secret', 'fallback-upstream-secret', 'archive-client-secret', 'archive-cookie-secret']) {
      assert.equal(applicationLogs.includes(secret), false, 'application logs must not contain credentials')
    }

    console.log(JSON.stringify({
      passed: true,
      failoverAttempts: failoverDetail.attempts.length,
      firstSseChunkMs: firstByteMs,
      archivedObjects: objectKeys.length,
      weighted: { primary: 1, fallback: 3 },
      circuit: { primaryAttemptsWhileOpening: 2, fallbackRequests: 3 },
      timeoutAttempts: timeoutDetail.attempts.length,
      concurrencyRejected: 12,
      multipartMiB: 6,
      oversizedStatus: 413,
      burstLimits: { rpm: [3, 17], requests: [3, 17], cost: [2, 18] },
      analytics: { today: 1, rolling24h: 2, all: 2 },
      rollup,
      edgeProbe: true,
      deletedDimensionsPreserved: true
    }))
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), delay(3000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await Promise.all([
      new Promise(resolve => primary.close(resolve)),
      new Promise(resolve => fallback.close(resolve)),
      new Promise(resolve => alertReceiver.close(resolve))
    ])
    await emptyBucket(s3).catch(() => {})
    await s3.send(new DeleteBucketCommand({ Bucket: s3Bucket })).catch(() => {})
    await appDb?.end().catch(() => {})
    await redis.flushdb().catch(() => {})
    await redis.quit().catch(() => redis.disconnect())
    await adminDb.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => {})
    await adminDb.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
