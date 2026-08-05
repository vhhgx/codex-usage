import { chromium, request } from 'playwright'

const baseUrl = process.env.UI_SMOKE_URL || 'http://127.0.0.1:3000'
const username = process.env.UI_SMOKE_ADMIN_USERNAME || 'admin'
const password = process.env.UI_SMOKE_ADMIN_PASSWORD || process.env.NUXT_ADMIN_PASSWORD || ''
const browserPath = process.env.UI_SMOKE_BROWSER || undefined
if (!password) throw new Error('UI_SMOKE_ADMIN_PASSWORD is required')

const channel = {
  id: 'channel-1', name: 'Primary Sub2API', type: 'sub2api', baseUrl: 'https://upstream.test', enabled: true,
  priority: 100, weight: 1, maxConcurrency: 20, timeoutMs: 120000, priceMultiplier: 1,
  healthStatus: 'healthy', circuitState: 'closed', lastHealthCheckAt: Date.now(), lastHealthError: null,
  models: [{ id: 'model-1', publicModel: 'gpt-test', upstreamModel: 'gpt-test', enabled: true, endpoints: [] }]
}
const group = {
  id: 'group-1', name: 'codex', description: 'Default development group', status: 'active', allowedEndpoints: [],
  rpmLimit: null, concurrencyLimit: null, dailyRequestLimit: null, dailyTokenLimit: null, dailyCostLimit: null,
  weeklyRequestLimit: null, weeklyTokenLimit: null, weeklyCostLimit: null, monthlyRequestLimit: null,
  monthlyTokenLimit: null, monthlyCostLimit: null, priceMultiplier: 1, userIds: [], userNames: [], models: [],
  channelIds: ['channel-1'], channelRules: [], keyCount: 0, usage: { requests: 0, tokens: 0, cost: 0 },
  createdAt: Date.now(), updatedAt: Date.now()
}
const proxy = {
  id: 'proxy-1', name: 'Hong Kong exit', protocol: 'socks5h', host: 'proxy.test', port: 1080,
  username: 'hub', hasPassword: true, status: 'active', expiresAt: null, fallbackMode: 'direct',
  backupProxyId: null, backupProxyName: null, expiryWarnDays: 7, accountCount: 3, latencyMs: 48,
  qualityScore: 99, lastCheckedAt: Date.now(), errorMessage: null
}

const browser = await chromium.launch({ headless: true, executablePath: browserPath })
try {
  const api = await request.newContext({ baseURL: baseUrl })
  const login = await api.post('/api/auth/login', { data: { username, password } })
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`)
  const storageState = await api.storageState()
  await api.dispose()
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, storageState })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.route('**/api/admin/channels', route => route.fulfill({ json: { channels: [channel] } }))
    await page.route('**/api/admin/settings', route => route.fulfill({ json: { settings: { defaultTimeoutMs: 120000 } } }))
    await page.route('**/api/admin/groups', route => route.fulfill({ json: { groups: [group] } }))
    await page.route('**/api/admin/users', route => route.fulfill({ json: { users: [] } }))
    await page.route('**/api/admin/models', route => route.fulfill({ json: { models: [{ publicModel: 'gpt-test' }] } }))
    await page.route('**/api/admin/upstreams', route => route.fulfill({ json: { upstreams: [{ id: 'sub2api', name: 'Sub2API', configured: true, baseUrl: null, capabilities: [] }] } }))
    await page.route('**/api/admin/upstreams/cpa/auth-files', route => route.fulfill({ json: { files: [] } }))
    await page.route('**/api/admin/upstreams/sub/proxies', route => route.fulfill({ json: {
      proxies: [proxy], defaultProxyId: proxy.id, cpaDefaultProxyId: proxy.id, cpaProxyMode: 'pool'
    } }))

    await page.goto(`${baseUrl}/admin/groups`)
    await page.waitForURL('**/admin/channels?tab=groups')
    await page.getByRole('heading', { name: '渠道、分组与套餐', exact: true }).waitFor()
    await page.getByRole('tab', { name: '渠道', exact: true }).waitFor()
    await page.getByRole('tab', { name: '分组', exact: true }).waitFor()
    await page.getByRole('tab', { name: '套餐', exact: true }).waitFor()
    await page.getByRole('heading', { name: '分组', exact: true }).waitFor()
    await page.getByRole('button', { name: '创建分组' }).waitFor()
    await page.screenshot({ path: `/tmp/zephyr-ui-smoke/${viewport.name}-channels-groups.png`, fullPage: true })

    await page.goto(`${baseUrl}/admin/upstreams`)
    await page.waitForLoadState('networkidle')
    await page.getByRole('tab', { name: '代理池', exact: true }).click()
    try { await page.getByText('Sub2API 新账号默认代理', { exact: true }).waitFor() } catch {
      throw new Error(`proxy tab did not render: ${JSON.stringify((await page.locator('.upstream-page').innerText()).slice(0, 1200))}`)
    }
    await page.getByText('CPA 全局默认代理', { exact: true }).waitFor()
    await page.getByText('Hong Kong exit', { exact: true }).first().waitFor()
    await page.screenshot({ path: `/tmp/zephyr-ui-smoke/${viewport.name}-proxies.png`, fullPage: true })
    if (pageErrors.length) throw new Error(`${viewport.name} page errors: ${JSON.stringify(pageErrors)}`)
    await context.close()
  }
} finally {
  await browser.close()
}

console.log(JSON.stringify({ passed: true, views: ['channels-groups', 'proxies'] }))
