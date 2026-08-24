import { mkdir } from 'node:fs/promises'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import argon2 from 'argon2'
import { chromium } from 'playwright'
import postgres from 'postgres'

const baseUrl = process.env.UI_SMOKE_URL || 'http://127.0.0.1:3000'
let username = process.env.UI_SMOKE_ADMIN_USERNAME || 'admin'
let password = process.env.UI_SMOKE_ADMIN_PASSWORD || process.env.NUXT_ADMIN_PASSWORD || ''
let userUsername = process.env.UI_SMOKE_USER_USERNAME || ''
let userPassword = process.env.UI_SMOKE_USER_PASSWORD || ''
const output = process.env.UI_SMOKE_OUTPUT || '/tmp/zephyr-ui-smoke'
const pages = process.env.UI_SMOKE_PAGES?.split(',').filter(Boolean) || ['/admin/users', '/admin/channels', '/admin/keys', '/admin/models', '/admin/settings', '/admin/audits', '/admin/account-vault', '/admin/upstreams']
const userPages = process.env.UI_SMOKE_USER_PAGES?.split(',').filter(Boolean) || ['/console', '/console/keys', '/console/resources', '/console/models', '/console/announcements', '/console/logs']
const baseViewports = process.env.UI_SMOKE_VIEWPORTS
  ? process.env.UI_SMOKE_VIEWPORTS.split(',').filter(Boolean).map((value) => {
      const match = value.trim().match(/^(\d+)x(\d+)$/)
      if (!match) throw new Error(`Invalid UI_SMOKE_VIEWPORTS entry: ${value}`)
      return { name: match[1], width: Number(match[1]), height: Number(match[2]) }
    })
  : [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]
const themes = process.env.UI_SMOKE_THEMES?.split(',').filter(theme => ['light', 'dark'].includes(theme)) || ['light']
const viewports = baseViewports.flatMap(viewport => themes.map(theme => ({
  ...viewport,
  theme,
  name: themes.length === 1 && theme === 'light' ? viewport.name : `${viewport.name}-${theme}`
})))
const bootstrap = process.env.UI_SMOKE_BOOTSTRAP === '1'
const skipFormLogin = process.env.UI_SMOKE_SKIP_FORM_LOGIN === '1'
const skipUser = process.env.UI_SMOKE_SKIP_USER === '1'
let fixtureDb
let fixtureIds = []
let fixtureAnnouncementIds = []
let fixtureAccountIds = []
let fixtureBindingIds = []
let fixtureReceiverIds = []

function syntheticJwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.synthetic`
}

function encryptedFixtureSecret(id, value, field = 'password') {
  const key = Buffer.from(String(process.env.NUXT_ENCRYPTION_KEY || ''), 'base64')
  if (key.length !== 32) throw new Error('UI smoke bootstrap requires a 32-byte NUXT_ENCRYPTION_KEY')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`zephyr-context-secret:account-vault:${id}:${field}:v2`, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

if (bootstrap) {
  fixtureDb = postgres(process.env.NUXT_DATABASE_URL, { max: 1 })
  const suffix = randomUUID().slice(0, 8)
  username = `ui-admin-${suffix}`
  userUsername = `ui-user-${suffix}`
  password = `UI-admin-${suffix}-password`
  userPassword = `UI-user-${suffix}-password`
  const [group] = await fixtureDb`select id from groups order by created_at limit 1`
  if (!group) throw new Error('UI smoke bootstrap requires at least one group')
  const [admin] = await fixtureDb`insert into users (username, display_name, password_hash, role, status, must_change_password, password_changed_at) values (${username}, 'UI Smoke Admin', ${await argon2.hash(password)}, 'super_admin', 'active', false, now()) returning id`
  const [user] = await fixtureDb`insert into users (username, display_name, password_hash, role, status, must_change_password, password_changed_at) values (${userUsername}, 'UI Smoke User', ${await argon2.hash(userPassword)}, 'user', 'active', false, now()) returning id`
  fixtureIds = [admin.id, user.id]
  const poolId = randomUUID()
  const upstreamSeed = Date.now() + Math.floor(Math.random() * 100000)
  await fixtureDb`insert into user_pool_groups (id, owner_user_id, upstream_user_id, upstream_group_id, upstream_api_key_id, encrypted_upstream_api_key, encryption_key_version, internal_name, display_name, status, max_accounts, created_by) values (${poolId}, ${user.id}, ${upstreamSeed}, ${upstreamSeed + 1}, ${upstreamSeed + 2}, 'ui-test-not-for-decryption', 'v2', ${`zh_pool_${poolId.replace(/-/g, '').slice(0, 12)}`}, 'UI Smoke 专属号池', 'active', 5, ${admin.id})`
  await fixtureDb`insert into group_memberships (group_id, user_id, role, created_by) values (${group.id}, ${admin.id}, 'manager', ${admin.id}), (${group.id}, ${user.id}, 'member', ${admin.id})`
  await fixtureDb`insert into channels (name, type, base_url, encrypted_api_key, owner_kind, owner_user_id, access_scope, created_by, credential_key_version, enabled, priority, weight, max_concurrency, timeout_ms, health_status, last_health_check_at, last_health_error) values
    ('UI Smoke Relay A', 'openai_compatible', 'https://relay-a.example.com', 'ui-test-not-for-decryption', 'user', ${user.id}, 'private', ${user.id}, 'v2', true, 10, 1, 5, 120000, 'healthy', now(), null),
    ('UI Smoke Relay B', 'openai_compatible', 'https://relay-b.example.com', 'ui-test-not-for-decryption', 'user', ${user.id}, 'private', ${user.id}, 'v2', true, 20, 1, 5, 120000, 'unhealthy', now(), 'UI Smoke 上游连接失败')`
  await fixtureDb`update channels set checkin_enabled = true, encrypted_checkin_token = 'ui-test-not-for-decryption' where owner_user_id = ${user.id} and name = 'UI Smoke Relay A'`
  const [announcement] = await fixtureDb`insert into announcements (title, content, tone, status, published_at, created_by) values ('UI Smoke 公告', '用户首页公告可见性检查', 'info', 'published', now(), ${admin.id}) returning id`
  fixtureAnnouncementIds = [announcement.id]
  const accountId = randomUUID()
  await fixtureDb`insert into account_vault_entries (id, email, display_name, status, encrypted_password, encrypted_totp_secret, purchase_date, warranty_status, remark, created_by, updated_by) values (${accountId}, ${`ui-account-${suffix}@example.com`}, 'UI Smoke Account', 'Codex', ${encryptedFixtureSecret(accountId, 'UI-Smoke-Account-Password')}, ${encryptedFixtureSecret(accountId, 'MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7', 'totp-secret')}, ${new Date().toISOString().slice(0, 10)}, '无质保', 'UI Smoke 账号备注', ${admin.id}, ${admin.id})`
  fixtureAccountIds = [accountId]
  let receivers = await fixtureDb`select id from sms_receivers where owner_user_id is null and status = 'active' order by created_at`
  if (!receivers.length) {
    const receiverId = randomUUID()
    await fixtureDb`insert into sms_receivers (id, phone, phone_key, provider_host, encrypted_fetch_url, note, status, created_by, updated_by) values (${receiverId}, '+1(202)5550100', '12025550100', 'sms-ui.example.com', 'ui-test-not-for-decryption', 'UI Smoke Receiver', 'active', ${admin.id}, ${admin.id})`
    fixtureReceiverIds = [receiverId]
    receivers = [{ id: receiverId }]
  }
  for (const receiver of receivers) {
    const occupied = await fixtureDb`select slot from sms_receiver_bindings where receiver_id = ${receiver.id}`
    const used = new Set(occupied.map(item => item.slot))
    const slot = [1, 2, 3].find(value => !used.has(value))
    if (!slot) continue
    const bindingId = randomUUID()
    await fixtureDb`insert into sms_receiver_bindings (id, receiver_id, account_id, account_email, account_display_name, slot, created_by) values (${bindingId}, ${receiver.id}, ${accountId}, ${`ui-account-${suffix}@example.com`}, 'UI Smoke Account', ${slot}, ${admin.id})`
    fixtureBindingIds = [bindingId]
    break
  }
  if (!fixtureBindingIds.length) {
    const receiverId = randomUUID()
    const bindingId = randomUUID()
    await fixtureDb`insert into sms_receivers (id, phone, phone_key, provider_host, encrypted_fetch_url, note, status, created_by, updated_by) values (${receiverId}, '+1(202)5550199', '12025550199', 'sms-ui.example.com', 'ui-test-not-for-decryption', 'UI Smoke Receiver', 'active', ${admin.id}, ${admin.id})`
    await fixtureDb`insert into sms_receiver_bindings (id, receiver_id, account_id, account_email, account_display_name, slot, created_by) values (${bindingId}, ${receiverId}, ${accountId}, ${`ui-account-${suffix}@example.com`}, 'UI Smoke Account', 1, ${admin.id})`
    fixtureReceiverIds = [receiverId]
    fixtureBindingIds = [bindingId]
  }
}

if (!password) throw new Error('UI_SMOKE_ADMIN_PASSWORD is required')
await mkdir(output, { recursive: true })
let browser
const results = []
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.UI_SMOKE_BROWSER || undefined })
  for (const viewport of viewports) {
    const targets = [
      ...(pages.length ? [{ name: 'admin', username, password, login: '/api/auth/login', logout: '/api/auth/logout', pages }] : []),
      ...(!skipUser && userUsername && userPassword ? [{ name: 'user', username: userUsername, password: userPassword, login: '/api/auth/login', logout: '/api/auth/logout', pages: userPages }] : [])
    ]
    for (const target of targets) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: viewport.theme
      })
      await context.addCookies([{ name: 'zephyr_theme', value: viewport.theme, url: baseUrl }])
      const page = await context.newPage()
      const pageErrors = []
      let themeChecked = false
      let drawerChecked = false
      page.on('pageerror', error => pageErrors.push(error.message))
      if (target.name === 'user' && !skipFormLogin) {
        await page.goto(baseUrl)
        await page.waitForURL(`${baseUrl}/login`)
        await page.waitForLoadState('networkidle')
        await page.getByLabel('用户名').fill(target.username)
        await page.getByLabel('密码').fill(target.password)
        await page.waitForFunction(() => {
          const button = document.querySelector('button[type="submit"]')
          return button instanceof HTMLButtonElement && !button.disabled
        })
        const [loginResponse] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST'),
          page.getByRole('button', { name: '登录', exact: true }).click({ noWaitAfter: true })
        ])
        const loginResult = await loginResponse.json().catch(() => null)
        if (!loginResponse.ok() || loginResult?.user?.role !== 'user' || loginResult?.home !== '/console') {
          throw new Error(`ordinary-user form login returned an invalid response: HTTP ${loginResponse.status()} ${JSON.stringify(loginResult)}`)
        }
        const cookies = await context.cookies(baseUrl)
        if (!cookies.some(cookie => cookie.name === 'zephyr_session')) {
          throw new Error(`ordinary-user form login did not store zephyr_session: ${JSON.stringify(cookies.map(({ name, domain, path, secure, sameSite }) => ({ name, domain, path, secure, sameSite })))}`)
        }
        const sessionResponse = await context.request.get(`${baseUrl}/api/auth/session`)
        const sessionResult = await sessionResponse.json().catch(() => null)
        if (!sessionResponse.ok() || !sessionResult?.authenticated || sessionResult?.user?.role !== 'user') {
          throw new Error(`ordinary-user session was not recognized after login: HTTP ${sessionResponse.status()} ${JSON.stringify(sessionResult)}`)
        }
        await page.waitForURL(`${baseUrl}/console`)
        await context.request.post(`${baseUrl}${target.logout}`)
      }
      const login = await context.request.post(`${baseUrl}${target.login}`, { data: { username: target.username, password: target.password } })
      if (!login.ok()) throw new Error(`${target.name} UI smoke login failed with HTTP ${login.status()}`)
      if (target.name === 'admin') {
        const loginResult = await login.json()
        const selfReset = await context.request.post(`${baseUrl}/api/admin/users/${loginResult.user.id}/reset-password`, { data: { password: `Blocked-${randomUUID()}-password` } })
        if (!selfReset.ok()) throw new Error(`self password reset should be accepted from user management, received ${selfReset.status()}`)
      }
      for (const path of target.pages) {
        const response = await page.goto(`${baseUrl}${path}`)
        if (!response?.ok()) throw new Error(`${path} returned HTTP ${response?.status()}`)
        await page.waitForLoadState('networkidle')
        if (!themeChecked && target.name === 'admin') {
          const expectedTheme = viewport.theme
          if (!await page.locator('html').evaluate((element, theme) => element.classList.contains(theme), expectedTheme)) {
            throw new Error(`${path} did not resolve the explicit ${expectedTheme} theme before interaction`)
          }
          const targetTheme = expectedTheme === 'dark' ? 'light' : 'dark'
          await page.getByRole('button', { name: expectedTheme === 'dark' ? '切换到亮色主题' : '切换到暗色主题' }).click()
          await page.waitForFunction(theme => document.documentElement.classList.contains(theme), targetTheme)
          await page.getByRole('button', { name: targetTheme === 'dark' ? '切换到亮色主题' : '切换到暗色主题' }).click()
          await page.waitForFunction(theme => document.documentElement.classList.contains(theme), expectedTheme)
          const cookie = (await context.cookies(baseUrl)).find(item => item.name === 'zephyr_theme')
          if (cookie?.value !== expectedTheme) throw new Error(`theme preference was not restored: ${cookie?.value}`)
          themeChecked = true
        }
        if (!drawerChecked && target.name === 'admin' && viewport.width <= 960) {
          const menu = page.getByRole('button', { name: '打开导航' })
          await menu.click()
          const sidebar = page.locator('.workspace-sidebar')
          const brand = sidebar.locator('.workspace-brand')
          const logout = sidebar.getByRole('button', { name: '退出登录' })
          await brand.focus()
          await page.keyboard.press('Shift+Tab')
          if (!await logout.evaluate(element => element === document.activeElement)) throw new Error('mobile drawer did not wrap focus backward')
          await page.keyboard.press('Tab')
          if (!await brand.evaluate(element => element === document.activeElement)) throw new Error('mobile drawer did not wrap focus forward')
          await page.keyboard.press('Escape')
          if (await menu.getAttribute('aria-expanded') !== 'false' || !await menu.evaluate(element => element === document.activeElement)) {
            throw new Error('mobile drawer did not close with Escape and restore focus')
          }
          drawerChecked = true
        }
        if (target.name === 'admin' && path === '/admin') {
          const labels = await page.locator('.workspace-nav a span').allTextContents()
          if (!labels.includes('运行总览') || !labels.includes('用户管理') || labels.includes('个人首页')) {
            throw new Error(`administrator received incorrect navigation: ${JSON.stringify(labels)}`)
          }
          const spotlight = page.locator('.spotlight-panel').first()
          if (viewport.width > 960) {
            await spotlight.hover({ position: { x: 24, y: 24 } })
            const position = await spotlight.evaluate(element => ({
              x: element.style.getPropertyValue('--spot-x'),
              y: element.style.getPropertyValue('--spot-y')
            }))
            if (!position.x || !position.y) throw new Error(`desktop spotlight did not track the pointer: ${JSON.stringify(position)}`)
          } else {
            const content = await spotlight.evaluate(element => getComputedStyle(element, '::before').content)
            if (content !== 'none') throw new Error(`mobile spotlight is still rendered: ${content}`)
          }
        }
        if (target.name === 'user' && path === '/console') {
          const labels = await page.locator('.workspace-nav a span').allTextContents()
          if (!labels.includes('个人首页') || !labels.includes('我的 Keys') || !labels.includes('公告') || labels.includes('用户管理')) {
            throw new Error(`ordinary user received incorrect navigation: ${JSON.stringify(labels)}`)
          }
          if (bootstrap && !await page.getByText('UI Smoke 公告', { exact: true }).count()) {
            throw new Error('published administrator announcement is not visible on the user homepage')
          }
        }
        if (target.name === 'user' && path === '/console/announcements' && bootstrap && !await page.getByText('UI Smoke 公告', { exact: true }).count()) {
          throw new Error('published administrator announcement is not visible on the user announcement page')
        }
        if (target.name === 'admin' && path === '/admin/models') {
          const response = await context.request.get(`${baseUrl}/api/admin/models`)
          const models = (await response.json()).models || []
          for (const model of models) {
            const row = page.locator('.model-config-row').filter({ has: page.getByText(model.publicModel, { exact: true }) })
            if (await row.locator('.image-price-editor').count() !== (model.imageCapable ? 1 : 0)) {
              throw new Error(`image price editor capability mismatch for ${model.publicModel}`)
            }
          }
          const syncPattern = /\/api\/admin\/models\/sync-prices$/
          await page.route(syncPattern, route => route.fulfill({ status: 200, json: {
            total: 2, updated: 2, unavailable: [], failed: [], imageTokenPricingNotImported: []
          } }))
          await page.getByRole('button', { name: '从上游同步价格', exact: true }).click()
          await page.locator('.app-toast[data-tone="success"]', { hasText: '已从上游更新 2 / 2 个模型' }).waitFor()
          await page.unroute(syncPattern)
        }
        const layout = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          fixedOverflow: [...document.querySelectorAll('button, select, input')].filter((element) => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            const insideHorizontalScroller = [...function * parents(node) {
              for (let parent = node.parentElement; parent; parent = parent.parentElement) yield parent
            }(element)].some(parent => {
              const overflow = getComputedStyle(parent).overflowX
              return (overflow === 'auto' || overflow === 'scroll') && parent.scrollWidth > parent.clientWidth
            })
            return style.visibility !== 'hidden' && rect.width > 0 && !insideHorizontalScroller && (rect.left < -1 || rect.right > window.innerWidth + 1)
          }).map((element) => {
            const rect = element.getBoundingClientRect()
            return { className: element.className, label: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim().slice(0, 40), left: Math.round(rect.left), right: Math.round(rect.right) }
          }),
          inaccessibleIconButtons: [...document.querySelectorAll('button')].filter((element) => {
            const style = getComputedStyle(element)
            const iconOnly = Boolean(element.querySelector('svg')) && !element.textContent?.trim()
            return iconOnly && style.display !== 'none' && style.visibility !== 'hidden'
              && (!element.getAttribute('aria-label') || !element.getAttribute('title'))
          }).map(element => ({
            className: element.className,
            ariaLabel: element.getAttribute('aria-label'),
            title: element.getAttribute('title')
          }))
        }))
        const name = path === '/console' ? 'overview' : path.split('/').filter(Boolean).at(-1)
        await page.screenshot({ path: `${output}/${viewport.name}-${target.name}-${name}.png`, fullPage: true })
        results.push({ viewport: viewport.name, theme: viewport.theme, target: target.name, path, pageErrors: [...pageErrors], ...layout })
        if (target.name === 'admin') {
          const legacyTablists = await page.locator('[role="tablist"].admin-segment').count()
          if (legacyTablists) throw new Error(`${path} still uses ${legacyTablists} legacy segmented tablist(s)`)
          const unstyledTablists = await page.locator('[role="tablist"]:not(.admin-page-tabs)').count()
          if (unstyledTablists) throw new Error(`${path} has ${unstyledTablists} tablist(s) without the shared admin page tab style`)
        }
        if (bootstrap && target.name === 'user' && path === '/console/keys') {
          if (!await page.locator('.workspace-nav').getByText('Keys 与用量', { exact: true }).count()) throw new Error('combined keys navigation label is missing')
          if (await page.locator('.keys-page [role="tablist"]').count()) throw new Error('keys page still separates Key and usage into tabs')
          const keysContent = page.locator('.keys-content')
          if (!await keysContent.locator('.usage-panel').count() || !await keysContent.locator('.console-table').count()) throw new Error('usage panel or key table is missing')
          const usageTop = await keysContent.locator('.usage-panel').boundingBox()
          const tableTop = await keysContent.locator('.console-table').boundingBox()
          if (!usageTop || !tableTop || usageTop.y >= tableTop.y) throw new Error('usage panel is not above the key table')
          await page.locator('.admin-page__header').getByRole('button', { name: '创建 Key', exact: true }).click()
          const createDialog = page.getByRole('dialog').filter({ hasText: '创建 Hub Key' })
          await createDialog.getByLabel('名称').fill(`UI Key ${viewport.name}`)
          const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/console/keys' && response.request().method() === 'POST')
          await createDialog.getByRole('button', { name: '创建 Key', exact: true }).click()
          if (!(await createResponse).ok()) throw new Error('ordinary user could not create a Hub Key')
          await page.getByText(`UI Key ${viewport.name}`, { exact: true }).waitFor()
          await page.getByTitle('停用 Key').click()
          await page.getByTitle('启用 Key').waitFor()
          await page.getByTitle('查看和编辑').click()
          const editDialog = page.locator('.app-drawer').filter({ hasText: `UI Key ${viewport.name}` })
          const revealResponse = page.waitForResponse(response => /\/api\/console\/keys\/[^/]+\/reveal$/.test(new URL(response.url()).pathname))
          await editDialog.getByRole('button', { name: '复制', exact: true }).click()
          if (!(await revealResponse).ok()) throw new Error('ordinary user could not reveal their Hub Key')
          if (!await editDialog.locator('.credential-mask code').textContent()) throw new Error('masked Hub Key was blank')
          await editDialog.getByTitle('关闭').click()
          await page.getByTitle('删除 Key').click()
          const deleteDialog = page.getByRole('alertdialog')
          const deleteResponse = page.waitForResponse(response => /\/api\/console\/keys\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'DELETE')
          await deleteDialog.getByRole('button', { name: '确认删除' }).click()
          if (!(await deleteResponse).ok()) throw new Error('ordinary user could not delete their Hub Key')
          await page.getByText('还没有 Hub Key', { exact: true }).waitFor()
        }
        if (target.name === 'user' && path === '/console/resources') {
          if (!await page.locator('.workspace-nav').getByText('套餐与资源', { exact: true }).count()) throw new Error('combined resource navigation label is missing')
          if (await page.getByRole('tab', { name: '权限与额度', exact: true }).count()) throw new Error('redundant access and quota tab is still visible')
          const relayOrderItems = page.locator('.relay-order__item')
          if (await relayOrderItems.count() !== 3) throw new Error('failover order did not render the package and all user relays')
          if (await page.locator('.relay-order__item[data-source-type="package"]').count() !== 1) throw new Error('failover order did not render exactly one package source')
          if (await page.locator('.relay-order').getByText('UI Smoke 上游连接失败', { exact: true }).count()) throw new Error('failover order still exposes channel error details')
          if (!await page.getByRole('button', { name: '一键签到', exact: true }).isEnabled()) throw new Error('bulk check-in is not available for a configured relay')
          if (!await page.getByRole('button', { name: 'UI Smoke Relay A 签到', exact: true }).count()) throw new Error('configured relay does not expose its check-in action')
          const nextRelayName = (await relayOrderItems.nth(1).locator('strong').innerText()).trim()
          const dragHandle = relayOrderItems.first().locator('.relay-order__grip')
          await dragHandle.scrollIntoViewIfNeeded()
          const [handleBox, targetBox] = await Promise.all([dragHandle.boundingBox(), relayOrderItems.nth(1).boundingBox()])
          if (!handleBox || !targetBox) throw new Error('relay drag handles are not visible')
          const targetPoint = { x: targetBox.x + Math.min(32, targetBox.width / 4), y: targetBox.y + targetBox.height / 2 }
          await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
          await page.mouse.down()
          if (await page.locator('.relay-order__item.is-dragging').count() !== 1) throw new Error('relay pointer drag did not start')
          await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 })
          if (!(await relayOrderItems.first().getByText(nextRelayName, { exact: true }).count())) {
            const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-relay-order-id]')?.getAttribute('aria-label') || null, targetPoint)
            throw new Error(`relay pointer drag did not reorder at target ${JSON.stringify({ targetPoint, hit })}`)
          }
          const reorderResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/console/relay-order' && response.request().method() === 'PUT')
          await page.mouse.up()
          if (!(await reorderResponse).ok()) throw new Error('relay failover order could not be saved')
          await relayOrderItems.first().getByText(nextRelayName, { exact: true }).waitFor()
          await page.getByRole('button', { name: '添加中转', exact: true }).click()
          const relayDrawer = page.getByRole('dialog', { name: '添加中转' })
          await relayDrawer.waitFor()
          if (!await relayDrawer.locator('input').count()) throw new Error('relay create form did not open in a drawer')
          await relayDrawer.getByRole('button', { name: '关闭' }).click()
          for (const tabName of ['我的中转', '专属号池']) {
            if (!await page.getByRole('tab', { name: tabName, exact: true }).count()) throw new Error(`combined user resource tab is missing: ${tabName}`)
            await page.getByRole('tab', { name: tabName, exact: true }).click()
          }
          await page.waitForURL(`${baseUrl}/console/resources?tab=pool`)
          await page.locator('.pool-page').waitFor({ state: 'attached', timeout: 5000 })
          const poolImport = page.getByRole('button', { name: '导入账号', exact: true })
          if (!await poolImport.count()) throw new Error('user pool import action is missing')
          if (await poolImport.isDisabled()) throw new Error('user pool import should be enabled after the pool exists')
          await poolImport.click()
          const importDrawer = page.getByRole('dialog', { name: '新增账号' })
          await importDrawer.waitFor()
          for (const mode of ['手动', '上传', '批量导入', '凭据转换']) {
            if (!await importDrawer.getByRole('tab', { name: mode, exact: true }).count()) throw new Error(`user pool import mode is missing: ${mode}`)
          }
          await importDrawer.getByRole('tab', { name: '批量导入', exact: true }).click()
          await importDrawer.getByLabel('来源 *').selectOption('ldxp')
          await importDrawer.getByText('2FA 密钥', { exact: true }).click()
          const privateDeliveryEmail = `user-pool-${viewport.name}@example.com`
          await importDrawer.locator('textarea').fill(`${privateDeliveryEmail}----secret-password----MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7`)
          await importDrawer.locator('.vault-delivery-preview').getByText('账号 + 密码 + 2FA 密钥', { exact: true }).waitFor()
          const userPoolPreview = await importDrawer.locator('.vault-delivery-preview').innerText()
          if (userPoolPreview.includes('secret-password') || userPoolPreview.includes('MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7')) {
            throw new Error('user pool delivery preview exposes imported credentials')
          }
          await page.screenshot({ path: `${output}/${viewport.name}-user-pool-batch-import.png`, fullPage: true })
          const privateDeliveryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/console/pool/account-vault/delivery-import' && response.request().method() === 'POST')
          await importDrawer.getByRole('button', { name: '确认导入', exact: true }).click()
          if (!(await privateDeliveryResponse).ok()) throw new Error('user pool batch import request failed')
          await page.locator('.pool-vault-section').getByText(privateDeliveryEmail, { exact: true }).first().waitFor()
          await page.getByRole('tab', { name: '接码管理', exact: true }).click()
          await page.getByRole('button', { name: '新增接码', exact: true }).waitFor()
          await page.screenshot({ path: `${output}/${viewport.name}-user-pool-receivers.png`, fullPage: true })
        }
        if (target.name === 'admin' && path === '/admin/channels') {
          if (!await page.locator('.workspace-nav').getByText('资源管理', { exact: true }).count()) throw new Error('combined resource navigation label is missing')
          await page.getByRole('heading', { name: '资源管理', exact: true }).waitFor()
          if (await page.locator('.resource-section-heading').count()) throw new Error('resource tabs still render duplicated section headings')
          const resourceHeader = page.locator('.admin-page__header')
          await resourceHeader.getByRole('button', { name: '添加渠道', exact: true }).waitFor()
          for (const tabName of ['渠道', '分组', '套餐']) {
            if (!await page.getByRole('tab', { name: tabName, exact: true }).count()) throw new Error(`combined resource tab is missing: ${tabName}`)
          }
          await page.getByRole('tab', { name: '分组', exact: true }).click()
          await resourceHeader.getByRole('button', { name: '创建分组', exact: true }).waitFor()
          if (await page.getByTitle('编辑分组').count()) {
            await page.getByTitle('编辑分组').first().click()
            await page.locator('.channel-policy-mode select').selectOption('custom')
            await page.locator('.group-channel-rules').scrollIntoViewIfNeeded()
            await page.screenshot({ path: `${output}/${viewport.name}-admin-groups-channel-policy.png`, fullPage: true })
            await page.getByTitle('关闭').click()
          }
          await page.screenshot({ path: `${output}/${viewport.name}-admin-channels-groups-tab.png`, fullPage: true })
          await page.getByRole('tab', { name: '套餐', exact: true }).click()
          await resourceHeader.getByRole('button', { name: '新建套餐', exact: true }).waitFor()
          await page.locator('.hub-plans-panel').waitFor()
          await page.screenshot({ path: `${output}/${viewport.name}-admin-channels-plans-tab.png`, fullPage: true })
        }
        if (target.name === 'admin' && path === '/admin/upstreams') {
          await page.getByRole('heading', { name: '号池配置', exact: true }).waitFor()
          if (!await page.locator('.workspace-nav').getByText('号池配置', { exact: true }).count()) throw new Error('pool settings navigation label was not updated')
          if (await page.getByRole('tab', { name: 'CPA 认证', exact: true }).count()) throw new Error('CPA auth tab should be managed from account management')
          if (await page.getByRole('tab', { name: 'Sub2API 账号', exact: true }).count()) throw new Error('duplicated Sub2API account tab should remain hidden from pool settings')
          await page.getByRole('tab', { name: 'Sub2API 分组', exact: true }).waitFor()
          await page.getByRole('tab', { name: '代理池', exact: true }).waitFor()
          await page.getByRole('tab', { name: '代理池', exact: true }).click()
          await page.getByText('Sub2API 新账号默认代理', { exact: true }).waitFor()
          await page.getByText('CPA 全局默认代理', { exact: true }).waitFor()
          await page.screenshot({ path: `${output}/${viewport.name}-admin-upstreams-proxy-pool.png`, fullPage: true })
          const operationsPattern = /\/api\/admin\/upstreams\/operations(?:\?.*)?$/
          await page.route(operationsPattern, route => route.fulfill({ status: 200, json: { operations: [{
            id: 'ui-operation', requestId: 'ui-request', connectionId: 'sub2api', action: 'sub.account.import',
            targetType: 'sub2api_account', targetRef: 'account-id', status: 'failed', upstreamStatus: 502,
            safeSummary: { name: '测试账号', operationStage: '创建账号' }, errorMessage: '创建账号失败：代理不存在', startedAt: Date.now(), completedAt: Date.now()
          }] } }))
          await page.getByRole('tab', { name: '操作记录', exact: true }).click()
          await page.getByText('导入 Sub2API 账号', { exact: true }).waitFor()
          await page.getByText('Sub2API 账号', { exact: true }).waitFor()
          await page.getByText('测试账号', { exact: true }).waitFor()
          await page.getByText('创建账号失败：代理不存在', { exact: true }).waitFor()
          if (await page.getByText('sub.account.import', { exact: true }).count() || await page.getByText('sub2api_account', { exact: true }).count()) {
            throw new Error('operation audit table still exposes machine values')
          }
          await page.screenshot({ path: `${output}/${viewport.name}-admin-upstreams-operations.png`, fullPage: true })
          await page.unroute(operationsPattern)
        }
        if (target.name === 'admin' && path === '/admin/account-vault') {
          if (!await page.locator('.workspace-shell > .workspace-sidebar').count()) throw new Error('account management is not using the admin layout')
          if (await page.locator('.site-header, .site-header__inner, .page-width.account-vault-page').count()) throw new Error('account management is incorrectly using the public site layout')
          const accountTypography = await page.evaluate(() => ({
            table: Number.parseFloat(getComputedStyle(document.querySelector('.account-workspace-table')).fontSize),
            badge: Number.parseFloat(getComputedStyle(document.querySelector('.record-badge')).fontSize)
          }))
          if (accountTypography.table < 13 || accountTypography.badge < 11) throw new Error(`account management typography is too small: ${JSON.stringify(accountTypography)}`)
          if (await page.locator('.vault-status-strip').count()) throw new Error('removed vault status strip is still rendered')
          if (!await page.getByRole('tab', { name: '账号管理', exact: true }).count() || !await page.getByRole('tab', { name: '接码管理', exact: true }).count()) {
            throw new Error('unified account page does not expose account and receiver tabs')
          }
          if (await page.getByRole('button', { name: '导入 Sub JSON', exact: true }).count()) throw new Error('standalone Sub2API JSON import action is still present')
          if (await page.getByRole('button', { name: '上传 CPA JSON', exact: true }).count()) throw new Error('standalone CPA JSON upload action is still present')
          if (await page.getByRole('button', { name: '导入 JSON', exact: true }).count()) throw new Error('legacy Vault backup import is still present')
          if (await page.getByRole('columnheader', { name: '运行状态', exact: true }).count() || await page.getByRole('columnheader', { name: '号池 / 接码', exact: true }).count()) {
            throw new Error('account table still exposes duplicated status columns')
          }
          await page.getByRole('columnheader', { name: '号池 / 凭据 / 状态', exact: true }).waitFor()
          if (await page.getByRole('columnheader', { name: '账号类型', exact: true }).count()) throw new Error('account type column was not merged into pool status')
          const fixtureRow = page.locator('.account-workspace-table tbody tr', { hasText: 'UI-Smoke-Account-Password' })
          await fixtureRow.waitFor()
          const fixtureIdentity = fixtureRow.locator('.account-identity')
          if ((await fixtureIdentity.innerText()).includes('UI Smoke Account')) throw new Error('account identity still renders legacy displayName')
          if ((await fixtureIdentity.innerText()).includes('UI Smoke 账号备注')) throw new Error('account identity still renders remarks')
          const passwordButton = fixtureIdentity.locator('.password-copy', { hasText: 'UI-Smoke-Account-Password' })
          await passwordButton.waitFor()
          const email = fixtureIdentity.locator('.account-email')
          const emailLayout = await email.evaluate((element) => {
            const style = getComputedStyle(element)
            return { maxWidth: style.maxWidth, overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace }
          })
          if (emailLayout.maxWidth !== 'none' || emailLayout.textOverflow === 'ellipsis' || emailLayout.whiteSpace !== 'nowrap') {
            throw new Error(`account email is constrained or truncated: ${JSON.stringify(emailLayout)}`)
          }
          await passwordButton.click()
          await page.getByText('账号密码已复制', { exact: true }).waitFor()

          const accountEditTrigger = page.getByTitle('编辑账号资料').first()
          await accountEditTrigger.click()
          let accountEditor = page.getByRole('dialog', { name: '编辑账号' })
          await accountEditor.waitFor()
          await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="编辑账号"]')?.contains(document.activeElement))
          await page.keyboard.press('Escape')
          await accountEditor.waitFor({ state: 'detached' })
          await page.waitForFunction(() => document.activeElement?.getAttribute('title') === '编辑账号资料')
          await accountEditTrigger.click()
          accountEditor = page.getByRole('dialog', { name: '编辑账号' })
          await accountEditor.waitFor()
          if (await accountEditor.getByRole('tab').count()) throw new Error('account editor exposes creation-mode tabs')
          if (!await accountEditor.locator('.account-editor-main').count() || !await accountEditor.locator('.account-editor-aside').count()) {
            throw new Error('account editor does not preserve the split form layout')
          }
          for (const removedField of ['购买日期', '质保日期', '质保状态']) {
            if (await accountEditor.getByText(removedField, { exact: true }).count()) {
              throw new Error(`account editor still exposes removed field: ${removedField}`)
            }
          }
          if (!await accountEditor.getByText('接码手机号', { exact: true }).count()) throw new Error('account editor cannot manually bind a receiver')
          await accountEditor.getByTitle('关闭').click()

          if (await page.getByRole('button', { name: '导入发货文本' }).count()) {
            throw new Error('delivery import still appears as a separate page action')
          }
          await page.getByRole('button', { name: '新增账号', exact: true }).click()
          const accountCreator = page.getByRole('dialog', { name: '新增账号' })
          await accountCreator.waitFor()
          for (const mode of ['手动', '上传', '批量导入', '凭据转换']) {
            if (!await accountCreator.getByRole('tab', { name: mode, exact: true }).count()) {
              throw new Error(`account creator is missing the ${mode} creation mode`)
            }
          }
          for (const removedMode of ['手动新增', '发货文本', '表单新增', '上传新增']) {
            if (await accountCreator.getByRole('tab', { name: removedMode, exact: true }).count()) {
              throw new Error(`account creator still exposes the removed ${removedMode} mode`)
            }
          }
          if (await accountCreator.locator('.account-editor-main > .account-editor-tabs').count() !== 1) {
            throw new Error('account creator tabs are not contained in the main form region')
          }
          const accountCreatorLayout = await accountCreator.locator('.account-editor-layout').evaluate((element) => ({
            display: getComputedStyle(element).display,
            overflow: element.closest('[role="dialog"]').scrollWidth - element.closest('[role="dialog"]').clientWidth
          }))
          const expectedAccountCreatorDisplay = viewport.width > 820 ? 'grid' : 'block'
          if (accountCreatorLayout.display !== expectedAccountCreatorDisplay || accountCreatorLayout.overflow > 1) {
            throw new Error(`account creator layout is invalid: ${JSON.stringify(accountCreatorLayout)}`)
          }
          await accountCreator.getByRole('tab', { name: '上传', exact: true }).click()
          const subUploadDrop = accountCreator.locator('.credential-drop', { hasText: '选择 Sub2API 账号 JSON' })
          const fileInputLayout = await subUploadDrop.locator('input[type="file"]').evaluate((element) => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            return { position: style.position, opacity: style.opacity, width: rect.width, height: rect.height }
          })
          if (fileInputLayout.position !== 'absolute' || fileInputLayout.opacity !== '0' || fileInputLayout.width > 1.1 || fileInputLayout.height > 1.1) {
            throw new Error(`account upload exposes the native file input: ${JSON.stringify(fileInputLayout)}`)
          }
          const poolSelect = accountCreator.getByLabel('号池平台 *')
          await poolSelect.selectOption('cpa')
          await accountCreator.getByText('选择 CPA 认证文件', { exact: true }).waitFor()
          if (await accountCreator.getByRole('button', { name: '导入 Sub2API', exact: true }).count()) throw new Error('Sub2API submit action is visible for the CPA pool')
          await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-cpa-upload.png`, fullPage: true })
          await poolSelect.selectOption('sub2api')
          await accountCreator.getByLabel('JSON 内容 *').waitFor()
          await accountCreator.getByRole('tab', { name: '凭据转换' }).click()
          const conversionEmail = `converter-${viewport.name}@example.com`
          const conversionAccess = syntheticJwt({
            email: conversionEmail,
            exp: Math.trunc(Date.now() / 1000) + 3600,
            'https://api.openai.com/auth': {
              chatgpt_account_id: `acct-converter-${viewport.name}`,
              chatgpt_plan_type: 'plus'
            }
          })
          const conversionRefresh = `synthetic-converter-refresh-${viewport.name}`
          const conversionSession = `synthetic-converter-session-${viewport.name}`
          const conversionInput = accountCreator.getByLabel('粘贴凭据 JSON')
          await conversionInput.fill(JSON.stringify({
            accessToken: conversionAccess,
            refreshToken: conversionRefresh,
            sessionToken: conversionSession,
            user: { email: conversionEmail }
          }))
          await accountCreator.getByRole('button', { name: '解析凭据', exact: true }).click()
          if (await conversionInput.inputValue() !== '') throw new Error('credential conversion textarea was not cleared after parsing')
          const conversionPreview = accountCreator.getByLabel('转换账号预览')
          await conversionPreview.locator('code', { hasText: conversionEmail }).waitFor()
          await conversionPreview.getByText('合成 ID Token', { exact: true }).waitFor()
          const previewText = await conversionPreview.innerText()
          if ([conversionAccess, conversionRefresh, conversionSession].some(secret => previewText.includes(secret))) {
            throw new Error('credential conversion preview exposes credentials')
          }
          await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-credential-converter.png`, fullPage: true })
          await accountCreator.getByRole('tab', { name: '手动', exact: true }).click()
          await accountCreator.getByLabel('邮箱 *').waitFor()
          await accountCreator.getByRole('tab', { name: '批量导入', exact: true }).click()
          await accountCreator.getByLabel('来源 *').selectOption('ldxp')
          await accountCreator.getByText('2FA 密钥', { exact: true }).click()
          await accountCreator.locator('textarea').fill('totp@example.com----secret-password----MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7')
          await accountCreator.getByText('totp@example.com', { exact: true }).waitFor()
          await accountCreator.locator('.vault-delivery-preview').getByText('账号 + 密码 + 2FA 密钥', { exact: true }).waitFor()
          if (await accountCreator.locator('.vault-delivery-preview', { hasText: 'secret-password' }).count() || await accountCreator.locator('.vault-delivery-preview', { hasText: 'MFLV3KISP5JROQOWHAQCLUVA4PO6YUM7' }).count()) {
            throw new Error('delivery preview exposes imported credentials')
          }
          await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-delivery-import.png`, fullPage: true })
          await accountCreator.getByTitle('关闭').click()

          if (await page.getByTitle('显示密码').count() || await page.getByTitle('隐藏密码').count()) {
            throw new Error('account table still exposes legacy password reveal controls')
          }

          const accountSmsCell = page.locator('.account-sms').first()
          if (await accountSmsCell.count()) {
            const refreshPattern = /\/api\/admin\/account-vault\/[^/]+\/sms\/refresh$/
            await page.route(refreshPattern, route => route.fulfill({
              status: 200,
              json: { result: { receiverId: 'ui-smoke', phone: '13800138000', code: '864209', message: '已获取新的短信验证码', fetchedAt: Date.now() } }
            }))
            await accountSmsCell.getByTitle('获取短信验证码').click()
            await accountSmsCell.getByText('864209', { exact: true }).waitFor()
            await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-code-received.png`, fullPage: true })
            await page.unroute(refreshPattern)
          }

          await page.getByRole('tab', { name: '接码管理', exact: true }).click()
          await page.locator('.receiver-table').waitFor()
          await page.getByRole('button', { name: '新增接码', exact: true }).click()
          const receiverCreator = page.getByRole('dialog', { name: '新增接码' })
          await receiverCreator.waitFor()
          if (!await receiverCreator.getByRole('tab', { name: '单个添加', exact: true }).count() || !await receiverCreator.getByRole('tab', { name: '批量导入', exact: true }).count()) {
            throw new Error('receiver creator does not expose single and batch modes')
          }
          await receiverCreator.getByRole('tab', { name: '批量导入', exact: true }).click()
          await receiverCreator.getByLabel('接码发货文本 *').fill('16232130689|https://sms.example.com/access?token=secret')
          await receiverCreator.getByText('sms.example.com', { exact: true }).waitFor()
          if (await receiverCreator.getByText('token=secret').count()) throw new Error('receiver import preview exposes URL credentials')
          await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-receiver-import.png`, fullPage: true })
          await receiverCreator.getByRole('tab', { name: '单个添加', exact: true }).click()
          await receiverCreator.getByTitle('关闭').click()
          if (await page.locator('.receiver-table tbody tr').count() < 1) throw new Error('receiver manager has no migrated receiver rows')
          if (await page.locator('.receiver-table').getByTitle('解除账号绑定').count()) throw new Error('receiver list exposes per-account binding removal controls')
          if (!await page.locator('.receiver-table tbody tr').getByText(/^[0-3]\/3$/).count()) throw new Error('receiver list does not show binding count')
          const boundReceiverRow = page.locator('.receiver-table tbody tr').filter({ hasText: /[1-3]\/3/ }).first()
          if (!await boundReceiverRow.count()) throw new Error('receiver manager fixture has no bound receiver')
          const refreshPattern = /\/api\/admin\/sms-receivers\/[^/]+\/refresh$/
          await page.route(refreshPattern, route => route.fulfill({
            status: 200,
            json: { result: { receiverId: 'ui-smoke', phone: '13800138000', code: '864209', message: '已获取新的短信验证码', fetchedAt: Date.now() } }
          }))
          await page.locator('.receiver-table tbody tr').first().getByTitle('刷新验证码').click()
          await page.locator('.app-toast[data-tone="success"]', { hasText: '已获取新的短信验证码' }).waitFor()
          await page.locator('.receiver-code code', { hasText: '864209' }).waitFor()
          await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-receivers.png`, fullPage: true })
          await page.unroute(refreshPattern)
          await boundReceiverRow.getByTitle('编辑接码').click()
          const receiverEditor = page.getByRole('dialog', { name: '编辑接码' })
          await receiverEditor.waitFor()
          if (!await receiverEditor.getByTitle('解除账号绑定').count()) throw new Error('receiver editor has no per-account binding removal control')
          await page.screenshot({ path: `${output}/${viewport.name}-admin-account-vault-receiver-editor.png`, fullPage: true })
          await receiverEditor.getByTitle('关闭').click()
        }
      }
      await context.request.post(`${baseUrl}${target.logout}`)
      await context.close()
    }
  }
} finally {
  try {
    await browser?.close()
  } finally {
    if (fixtureDb && fixtureIds.length) {
      if (fixtureBindingIds.length) await fixtureDb`delete from sms_receiver_bindings where id in ${fixtureDb(fixtureBindingIds)}`
      if (fixtureAccountIds.length) await fixtureDb`delete from account_vault_entries where id in ${fixtureDb(fixtureAccountIds)}`
      if (fixtureReceiverIds.length) await fixtureDb`delete from sms_receivers where id in ${fixtureDb(fixtureReceiverIds)}`
      if (fixtureAnnouncementIds.length) await fixtureDb`delete from announcements where id in ${fixtureDb(fixtureAnnouncementIds)}`
      await fixtureDb`delete from audit_logs where admin_id in ${fixtureDb(fixtureIds)}`
      await fixtureDb`delete from users where id in ${fixtureDb(fixtureIds)}`
      await fixtureDb.end()
    }
  }
}

if (results.some(result => result.documentWidth > result.viewportWidth + 1 || result.fixedOverflow.length > 0 || result.inaccessibleIconButtons.length > 0 || result.pageErrors.length)) {
  throw new Error(`UI overflow detected: ${JSON.stringify(results)}`)
}
console.log(JSON.stringify({ passed: true, results, output }))
