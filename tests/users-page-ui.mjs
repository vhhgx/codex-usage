import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.UI_SMOKE_URL || 'http://127.0.0.1:3000'
const password = process.env.UI_SMOKE_ADMIN_PASSWORD || process.env.NUXT_ADMIN_PASSWORD || ''
const browserPath = process.env.UI_SMOKE_BROWSER || '/usr/bin/google-chrome'
const output = process.env.UI_USERS_OUTPUT || '/tmp/zephyr-users-ui'
const viewports = [
  { name: 'mobile', width: 375, height: 844 },
  { name: 'desktop', width: 1440, height: 1000 }
]
const themes = ['dark', 'light']

if (!password) throw new Error('UI_SMOKE_ADMIN_PASSWORD is required')
await mkdir(output, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: browserPath })
try {
  let sequence = 0
  for (const theme of themes) {
    for (const viewport of viewports) {
      sequence += 1
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${sequence}` }
      })
      await context.addCookies([{ name: 'zephyr_theme', value: theme, url: baseUrl }])
      const login = await context.request.post(`${baseUrl}/api/auth/login`, { data: { username: 'admin', password } })
      if (!login.ok()) throw new Error(`login failed for ${theme}/${viewport.name}: HTTP ${login.status()}`)

      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', error => pageErrors.push(error.message))
      await page.goto(`${baseUrl}/admin/users`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(700)
      if (!await page.locator('html').evaluate((element, value) => element.classList.contains(value), theme)) {
        throw new Error(`theme ${theme} did not resolve for ${viewport.name}`)
      }
      const layout = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        transition: getComputedStyle(document.querySelector('.users-table')).transitionDuration,
        fixedOverflow: [...document.querySelectorAll('button, select, input')].filter(element => {
          const rect = element.getBoundingClientRect()
          const insideScroller = [...function * parents(node) {
            for (let parent = node.parentElement; parent; parent = parent.parentElement) yield parent
          }(element)].some(parent => ['auto', 'scroll'].includes(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth)
          return getComputedStyle(element).visibility !== 'hidden' && rect.width > 0 && !insideScroller && (rect.left < -1 || rect.right > window.innerWidth + 1)
        }).map(element => element.getAttribute('aria-label') || element.textContent?.trim()),
        entryOpacity: getComputedStyle(document.querySelector('.users-page__header')).opacity,
        entryAnimation: getComputedStyle(document.querySelector('.users-page__header')).animationName
      }))
      if (layout.documentWidth !== viewport.width || layout.fixedOverflow.length) throw new Error(`layout overflow at ${theme}/${viewport.name}: ${JSON.stringify(layout)}`)
      if (layout.entryOpacity !== '1' || !layout.entryAnimation.startsWith('users-panel-enter')) throw new Error(`page entry motion missing at ${theme}/${viewport.name}: ${JSON.stringify(layout)}`)
      if (pageErrors.length) throw new Error(`page error at ${theme}/${viewport.name}: ${pageErrors.join('; ')}`)
      const filterTriggers = await page.locator('.users-toolbar button[aria-haspopup="listbox"]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
      if (JSON.stringify(filterTriggers) !== JSON.stringify(['筛选角色', '筛选状态', '筛选分组'])) {
        throw new Error(`user filter triggers do not match contract at ${theme}/${viewport.name}: ${JSON.stringify(filterTriggers)}`)
      }
      await page.getByRole('button', { name: '筛选角色' }).click()
      const roleListbox = page.getByRole('listbox', { name: '筛选角色' })
      await roleListbox.waitFor({ state: 'visible' })
      if (await roleListbox.getByRole('option').count() !== 3) throw new Error(`role filter options are incomplete at ${theme}/${viewport.name}`)
      const menuBox = await roleListbox.boundingBox()
      if (!menuBox || menuBox.x < 0 || menuBox.x + menuBox.width > viewport.width) throw new Error(`role filter menu overflow at ${theme}/${viewport.name}: ${JSON.stringify(menuBox)}`)
      await page.keyboard.press('Escape')
      await roleListbox.waitFor({ state: 'detached' })
      await page.screenshot({ path: `${output}/${theme}-${viewport.name}-list.png`, fullPage: true })

      await page.getByRole('button', { name: '创建用户', exact: true }).click()
      const form = page.locator('.users-modal')
      await form.waitFor({ state: 'visible' })
      await page.waitForTimeout(340)
      const formMotion = await form.evaluate(element => ({ opacity: getComputedStyle(element).opacity, transition: getComputedStyle(element).transitionDuration }))
      if (formMotion.transition === '0s' || formMotion.opacity !== '1') throw new Error(`modal motion missing at ${theme}/${viewport.name}: ${JSON.stringify(formMotion)}`)
      await page.screenshot({ path: `${output}/${theme}-${viewport.name}-create.png` })
      await page.getByRole('button', { name: '关闭用户表单' }).click()
      await form.waitFor({ state: 'detached' })

      const editButton = page.getByRole('button', { name: '编辑用户' }).first()
      if (await editButton.count()) {
        await editButton.click()
        await form.waitFor({ state: 'visible' })
        const editControls = await form.evaluate(element => ({
          passwordInput: element.querySelector('input[placeholder="留空表示不修改"]') !== null,
          roleOptions: element.querySelectorAll('input[name="user-role"]').length,
          statusSwitch: element.querySelector('.users-status-switch input[type="checkbox"]') !== null,
          statusSelect: element.querySelector('.users-status-field select') !== null
        }))
        if (!editControls.passwordInput || editControls.roleOptions !== 2 || !editControls.statusSwitch || editControls.statusSelect) {
          throw new Error(`user edit controls do not match contract at ${theme}/${viewport.name}: ${JSON.stringify(editControls)}`)
        }
        await page.getByRole('button', { name: '关闭用户表单' }).click()
        await form.waitFor({ state: 'detached' })
      }

      const detailButton = page.getByRole('button', { name: '用户详情' }).first()
      if (await detailButton.count()) {
        await detailButton.click()
        const drawer = page.locator('.users-detail-drawer')
        await drawer.waitFor({ state: 'visible' })
        await page.waitForTimeout(340)
        const drawerMotion = await drawer.evaluate(element => ({ transform: getComputedStyle(element).transform, transition: getComputedStyle(element).transitionDuration }))
        if (drawerMotion.transition === '0s' || drawerMotion.transform === 'none') throw new Error(`drawer motion missing at ${theme}/${viewport.name}: ${JSON.stringify(drawerMotion)}`)
        await page.screenshot({ path: `${output}/${theme}-${viewport.name}-detail.png` })
        await page.getByRole('button', { name: '关闭用户详情' }).click()
        await drawer.waitFor({ state: 'detached' })
      }
      const deleteButton = page.getByRole('button', { name: '删除用户' }).last()
      if (await deleteButton.count() && await deleteButton.isEnabled()) {
        await deleteButton.click()
        const confirm = page.getByRole('alertdialog')
        await confirm.waitFor({ state: 'visible' })
        await page.waitForTimeout(340)
        const confirmMotion = await confirm.evaluate(element => ({ opacity: getComputedStyle(element).opacity, transition: getComputedStyle(element).transitionDuration }))
        if (confirmMotion.transition === '0s' || confirmMotion.opacity !== '1') throw new Error(`confirm motion missing at ${theme}/${viewport.name}: ${JSON.stringify(confirmMotion)}`)
        await page.getByRole('button', { name: '取消' }).click()
      }
      await context.close()
    }
  }
  console.log(JSON.stringify({ passed: true, output }))
} finally {
  await browser.close()
}
