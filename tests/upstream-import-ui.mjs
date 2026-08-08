import { randomUUID } from 'node:crypto'
import argon2 from 'argon2'
import { chromium } from 'playwright'
import postgres from 'postgres'

const baseUrl = process.env.UI_SMOKE_URL || 'http://127.0.0.1:3000'
let username = process.env.UI_SMOKE_ADMIN_USERNAME || 'admin'
let password = process.env.UI_SMOKE_ADMIN_PASSWORD || process.env.NUXT_ADMIN_PASSWORD || ''
const browserPath = process.env.UI_SMOKE_BROWSER || undefined
const bootstrap = process.env.UI_SMOKE_BOOTSTRAP === '1'

function syntheticJwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.synthetic`
}

const bundle = {
  accounts: [
    { name: 'alpha@example.com', platform: 'openai', type: 'oauth', concurrency: 10, priority: 1, credentials: { email: 'alpha@example.com', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } },
    { platform: 'openai', type: 'oauth', concurrency: 8, priority: 2, credentials: { email: 'beta@example.com', access_token: 'synthetic-access-2', refresh_token: 'synthetic-refresh-2' } }
  ]
}

if (!process.env.NUXT_DATABASE_URL) throw new Error('NUXT_DATABASE_URL is required for the temporary OAuth account')
const fixtureDb = postgres(process.env.NUXT_DATABASE_URL, { max: 1 })
const fixtureId = randomUUID()
let fixtureAdminId = null
if (bootstrap) {
  const suffix = fixtureId.slice(0, 8)
  username = `oauth-ui-admin-${suffix}`
  password = `OAuth-UI-${suffix}-password`
  const [admin] = await fixtureDb`insert into users (username, password_hash, role, status, must_change_password, password_changed_at) values (${username}, ${await argon2.hash(password)}, 'super_admin', 'active', false, now()) returning id`
  fixtureAdminId = admin.id
}
if (!password) throw new Error('UI_SMOKE_ADMIN_PASSWORD is required')
const fixtureEmail = `oauth-ui-${fixtureId.slice(0, 8)}@example.com`
await fixtureDb`insert into account_vault_entries (id, email, status, encrypted_password, purchase_date, warranty_status) values (${fixtureId}, ${fixtureEmail}, 'Codex', 'ui-test-not-for-decryption', '2026-08-05', '无质保')`
const localAccount = {
  id: fixtureId, email: fixtureEmail, displayName: null, status: 'Codex', credentialKind: 'password',
  hasEmailCodeUrl: false, hasTotpSecret: false, sub2apiAccountId: null, codexAddedAt: null, maskedPassword: '••••••••',
  purchaseDate: '2026-08-05', warrantyDate: null, warrantyStatus: '无质保', smsReceiver: null,
  remark: null, createdAt: Date.now(), updatedAt: Date.now()
}

let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: browserPath })
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport })
    const login = await context.request.post(`${baseUrl}/api/auth/login`, { data: { username, password } })
    if (!login.ok()) throw new Error(`login failed: ${login.status()}`)
    const page = await context.newPage()
    const pageErrors = []
    let oauthStartBody = null
    let oauthCompleteBody = null
    let conversionCpaUpload = null
    let uploadSubImportBody = null
    let conversionSubImportBody = null
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.route('**/api/admin/account-vault', route => route.fulfill({ json: { items: [localAccount] } }))
    await page.route('**/api/admin/account-vault/passwords', route => route.fulfill({ json: { items: [{ id: fixtureId, password: 'OAuth-UI-Account-Password' }] } }))
    await page.route('**/api/admin/sms-receivers', route => route.fulfill({ json: { items: [] } }))
    await page.route('**/api/sub2api/accounts', route => route.fulfill({ json: {
      results: [], accountCount: 0, successCount: 0, failureCount: 0, generatedAt: Date.now()
    } }))
    await page.route('**/api/admin/upstreams/sub/accounts', route => route.fulfill({ json: { accounts: [] } }))
    await page.route('**/api/admin/upstreams/cpa/auth-files', async route => {
      if (route.request().method() === 'POST') {
        conversionCpaUpload = {
          contentType: route.request().headers()['content-type'] || '',
          body: route.request().postDataBuffer()
        }
        await route.fulfill({ json: { files: [], failed: [] } })
        return
      }
      await route.fulfill({ json: { files: [{
        id: 'cpa-auth-file', name: 'codex-oauth.json', provider: 'codex', account: fixtureEmail,
        planType: 'plus', status: 'active', statusMessage: null, disabled: false, lastRefreshAt: Date.now()
      }] } })
    })
    await page.route('**/api/admin/upstreams/sub/accounts/import', async route => {
      const body = route.request().postDataJSON()
      if (Array.isArray(body.accounts) && body.accounts[0]?.name === 'alpha@example.com') uploadSubImportBody = body
      else conversionSubImportBody = body
      await route.fulfill({ json: {
        mode: 'accounts',
        created: (body.accounts || []).map((item, index) => ({ id: `converted-${index}`, name: item.name })),
        failed: []
      } })
    })
    await page.route('**/api/admin/upstreams/sub/proxies', route => route.fulfill({ json: { defaultProxyId: null, cpaDefaultProxyId: null, cpaProxyMode: 'direct', proxies: [
      { id: 'proxy-default', name: 'Default proxy', protocol: 'socks5h', host: 'proxy.test', port: 1080, username: null, hasPassword: true, status: 'active', expiresAt: null, fallbackMode: 'direct', backupProxyId: null, backupProxyName: null, expiryWarnDays: 7, accountCount: 0, latencyMs: 42, qualityScore: 98, lastCheckedAt: null, errorMessage: null }
    ] } }))
    await page.route('**/api/admin/upstreams/sub/groups', route => route.fulfill({ json: { groups: [
      { id: 'group-codex', name: 'codex', description: null, platform: 'openai', status: 'active', subscriptionType: 'standard', rateMultiplier: 1, dailyLimit: null, weeklyLimit: null, monthlyLimit: null, rpmLimit: null, allowImage: false, allowVideo: false, fallbackGroupId: null, fallbackGroupName: null, invalidFallbackGroupId: null, invalidFallbackGroupName: null, accountCount: 0, policy: {}, updatedAt: null },
      { id: 'group-other', name: 'other', description: null, platform: 'openai', status: 'active', subscriptionType: 'standard', rateMultiplier: 1, dailyLimit: null, weeklyLimit: null, monthlyLimit: null, rpmLimit: null, allowImage: false, allowVideo: false, fallbackGroupId: null, fallbackGroupName: null, invalidFallbackGroupId: null, invalidFallbackGroupName: null, accountCount: 0, policy: {}, updatedAt: null }
    ] } }))
    await page.route('**/api/admin/upstreams/sub/accounts/oauth/start', async route => {
      oauthStartBody = route.request().postDataJSON()
      await route.fulfill({ json: {
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?client_id=test&state=state-value',
        flowId: 'flow-id-value-abcdefghijklmnopqrstuvwxyz123456',
        expiresAt: Date.now() + 30 * 60 * 1000
      } })
    })
    await page.route('**/api/admin/upstreams/sub/accounts/oauth/complete', async route => {
      oauthCompleteBody = route.request().postDataJSON()
      await route.fulfill({ json: { account: {
        id: 'account-oauth', name: 'oauth@example.com', notes: null, platform: 'openai', type: 'oauth',
        status: 'active', schedulable: true, priority: 0, concurrency: 10, currentConcurrency: 0,
        rateMultiplier: 1, groupIds: ['group-codex'], groupNames: ['codex'], proxyId: 'proxy-default',
        proxyName: 'Default proxy', proxyFallbackOriginId: null, proxyEditable: true, expiresAt: null,
        errorMessage: null, updatedAt: Date.now()
      } } })
    })
    await page.goto(`${baseUrl}/admin`)
    await page.getByRole('link', { name: '账号管理', exact: true }).click()
    await page.waitForURL('**/admin/account-vault')
    await page.waitForLoadState('networkidle')
    if (!await page.locator('.admin-shell > .admin-sidebar').count()) throw new Error('account management did not render the admin sidebar')
    if (await page.locator('.site-header').count()) throw new Error('account management rendered the public site header')
    await page.getByTitle('刷新全部数据').click()
    await page.waitForLoadState('networkidle')
    const createButton = page.getByRole('button', { name: '新增账号', exact: true })
    try { await createButton.waitFor({ state: 'visible', timeout: 10000 }) } catch {
      throw new Error(`account create button missing; header=${JSON.stringify(await page.locator('.admin-page__header').innerText())}; errors=${JSON.stringify(pageErrors)}`)
    }
    const accountRow = page.locator('.account-workspace-table tbody tr').filter({ hasText: fixtureEmail })
    const accountIdentity = accountRow.locator('.account-identity')
    await accountIdentity.getByText('CPA', { exact: true }).waitFor()
    await accountIdentity.getByText('plus', { exact: true }).waitFor()
    await accountIdentity.locator('.password-copy', { hasText: 'OAuth-UI-Account-Password' }).waitFor()
    await accountRow.getByTitle('管理 CPA 认证文件').click()
    const cpaManager = page.getByRole('dialog', { name: '管理 CPA 认证文件' })
    await cpaManager.getByText('codex-oauth.json', { exact: true }).waitFor()
    await cpaManager.getByTitle('关闭').click()
    await createButton.click()
    const importDialog = page.getByRole('dialog', { name: '新增账号' })
    await importDialog.getByRole('tab', { name: '上传新增' }).click()
    await importDialog.getByLabel('号池平台 *').selectOption('sub2api')
    await importDialog.getByLabel('JSON 内容 *').fill(JSON.stringify(bundle))
    await importDialog.getByRole('button', { name: '解析内容' }).click()
    if (await importDialog.locator('.sub-import-preview > div').count() !== 2) throw new Error('expected two parsed accounts')
    if (/synthetic-access|synthetic-refresh/.test(await importDialog.locator('.sub-import-preview').innerText())) throw new Error('import preview exposes credentials')
    await page.screenshot({ path: `/tmp/zephyr-ui-smoke/${viewport.name}-upstream-import.png`, fullPage: true })
    await importDialog.getByRole('button', { name: '导入 Sub2API', exact: true }).click()
    await importDialog.waitFor({ state: 'detached' })
    if (uploadSubImportBody?.accounts?.[0]?.proxyId !== null || uploadSubImportBody?.accounts?.[1]?.proxyId !== null) {
      throw new Error(`uploaded JSON did not submit a null direct proxy: ${JSON.stringify(uploadSubImportBody?.accounts?.map(item => item.proxyId))}`)
    }

    await createButton.click()
    const converterDialog = page.getByRole('dialog', { name: '新增账号' })
    await converterDialog.getByRole('tab', { name: '凭据转换' }).click()
    const convertedEmail = `converted-${viewport.name}@example.com`
    const convertedAccess = syntheticJwt({
      email: convertedEmail,
      exp: Math.trunc(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: `acct-converted-${viewport.name}`,
        chatgpt_plan_type: 'plus',
        chatgpt_user_id: `user-converted-${viewport.name}`
      }
    })
    const convertedRefresh = `synthetic-converted-refresh-${viewport.name}`
    const convertedSession = `synthetic-converted-session-${viewport.name}`
    const convertedId = syntheticJwt({
      email: convertedEmail,
      exp: Math.trunc(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: `acct-converted-${viewport.name}` }
    })
    await converterDialog.getByLabel('粘贴凭据 JSON').fill(JSON.stringify({
      accessToken: convertedAccess,
      refreshToken: convertedRefresh,
      sessionToken: convertedSession,
      idToken: convertedId,
      user: { email: convertedEmail }
    }))
    await converterDialog.getByRole('button', { name: '解析凭据', exact: true }).click()
    const conversionRow = converterDialog.locator('.conversion-list article').filter({ hasText: convertedEmail })
    await conversionRow.getByRole('checkbox', { name: `导入 ${convertedEmail} 到 CPA` }).check()
    await page.screenshot({ path: `/tmp/zephyr-ui-smoke/${viewport.name}-credential-converter.png`, fullPage: true })
    const conversionSubmit = converterDialog.getByRole('button', { name: '转换并导入', exact: true })
    await conversionSubmit.scrollIntoViewIfNeeded()
    const submitVisibility = await conversionSubmit.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight, unobstructed: hit === element || element.contains(hit) }
    })
    if (submitVisibility.top < 0 || submitVisibility.bottom > submitVisibility.viewportHeight || !submitVisibility.unobstructed) {
      throw new Error(`credential converter submit action is obstructed: ${JSON.stringify(submitVisibility)}`)
    }
    await page.screenshot({ path: `/tmp/zephyr-ui-smoke/${viewport.name}-credential-converter-footer.png` })
    await conversionSubmit.click()
    await converterDialog.waitFor({ state: 'detached' })
    if (!conversionCpaUpload?.contentType.startsWith('multipart/form-data; boundary=')) {
      throw new Error('credential converter did not submit CPA credentials as multipart data')
    }
    if (!conversionCpaUpload.body?.length || !conversionCpaUpload.body.includes(Buffer.from('codex-converted-'))) {
      throw new Error('credential converter CPA upload did not include a converted JSON file')
    }
    const submittedCredentials = conversionSubImportBody?.accounts?.[0]?.credentials
    if (submittedCredentials?.access_token !== convertedAccess
      || submittedCredentials?.refresh_token !== convertedRefresh
      || submittedCredentials?.session_token !== convertedSession
      || submittedCredentials?.id_token !== convertedId) {
      throw new Error('credential converter did not preserve all Sub2API credential tokens')
    }
    if (conversionSubImportBody?.accounts?.[0]?.proxyId !== null) {
      throw new Error(`pasted credentials did not submit a null direct proxy: ${JSON.stringify(conversionSubImportBody?.accounts?.[0]?.proxyId)}`)
    }

    await page.getByTitle('Auth 登录并接入 Codex').click()
    const selectedGroupIds = await page.locator('.oauth-group-picker input:checked').evaluateAll(elements => elements.map(element => element.value))
    if (!selectedGroupIds.length) throw new Error('a Codex group must be selected for OAuth')
    await page.locator('.oauth-account-form select').first().inputValue()
    await page.getByRole('button', { name: '生成授权链接' }).click()
    const authUrl = await page.getByLabel('OpenAI 授权链接').inputValue()
    if (!authUrl.startsWith('https://auth.openai.com/')) throw new Error(`unexpected auth URL: ${authUrl}`)
    await page.locator('.oauth-callback-field textarea').fill('http://localhost:1455/auth/callback?code=one-time-code&state=state-value')
    await page.screenshot({ path: `/tmp/zephyr-ui-smoke/${viewport.name}-upstream-oauth.png`, fullPage: true })
    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      htmlOverflow: getComputedStyle(document.documentElement).overflowX,
      bodyOverflow: getComputedStyle(document.body).overflowX,
      sidebar: (() => {
        const element = document.querySelector('.admin-sidebar')
        if (!element) return null
        const style = getComputedStyle(element)
        return { width: style.width, overflow: style.overflow, contain: style.contain, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
      })(),
      navigation: (() => {
        const element = document.querySelector('.admin-nav')
        return element ? { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflow: getComputedStyle(element).overflowX } : null
      })(),
      offenders: [...document.querySelectorAll('body *')].map(element => {
        const rect = element.getBoundingClientRect()
        return { tag: element.tagName, className: element.className, left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
      }).filter(item => item.width > 0 && (item.left < -1 || item.right > window.innerWidth + 1)).sort((a, b) => b.right - a.right).slice(0, 12)
    }))
    if (layout.documentWidth > layout.viewportWidth + 1) throw new Error(`account page has horizontal overflow: ${JSON.stringify(layout)}`)
    await page.getByRole('button', { name: '完成授权' }).click()
    await page.locator('.oauth-account-modal').waitFor({ state: 'detached' })
    if (!Object.prototype.hasOwnProperty.call(oauthStartBody || {}, 'proxyId')) throw new Error(`OAuth start did not submit proxy selection: ${JSON.stringify(oauthStartBody)}`)
    if (oauthStartBody?.accountVaultId !== fixtureId) throw new Error(`OAuth start local-account mismatch: ${JSON.stringify(oauthStartBody)}`)
    if (oauthCompleteBody?.callbackUrl !== 'http://localhost:1455/auth/callback?code=one-time-code&state=state-value') throw new Error(`OAuth callback mismatch: ${JSON.stringify(oauthCompleteBody)}`)
    if (oauthCompleteBody?.groupIds?.join(',') !== selectedGroupIds.join(',')) throw new Error(`OAuth group mismatch: ${JSON.stringify(oauthCompleteBody)}`)
    if (oauthCompleteBody?.accountVaultId !== fixtureId) throw new Error(`OAuth complete local-account mismatch: ${JSON.stringify(oauthCompleteBody)}`)
    if (/access_token|refresh_token|credentials/i.test(JSON.stringify(oauthCompleteBody))) throw new Error('OAuth browser request must not contain credentials')
    if (pageErrors.length) throw new Error(`page errors: ${JSON.stringify(pageErrors)}`)
    await context.close()
  }
} finally {
  await browser?.close()
  await fixtureDb`delete from account_vault_entries where id = ${fixtureId}`
  if (fixtureAdminId) {
    await fixtureDb`delete from audit_logs where admin_id = ${fixtureAdminId}`
    await fixtureDb`delete from users where id = ${fixtureAdminId}`
  }
  await fixtureDb.end()
}

console.log(JSON.stringify({ passed: true, accounts: 2, defaultGroup: 'codex', oauth: true }))
