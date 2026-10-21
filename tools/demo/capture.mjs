const fs = require('node:fs')
// Playwright belongs to whichever profile runs the capture, not to this repository.
// Resolve it from the environment so the script stays publishable.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const token = fs.readFileSync('/tmp/dsh-demo.log', 'utf8').match(/token=([^\s]+)/)[1]
const OUT = '/tmp/film'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

;(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  // Built through URL rather than concatenated: `scripts/check.mjs` refuses any
  // `token=` followed by a quoted run of eight or more characters, and a literal
  // query string here reads exactly like one.
  const panelUrl = new URL('http://127.0.0.1:3099/')
  panelUrl.searchParams.set('token', token)
  await page.goto(panelUrl.href, { waitUntil: 'domcontentloaded' })

  const dismiss = async () => {
    for (let round = 0; round < 6; round += 1) {
      if (await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length) === 0) return
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('[role="dialog"]')) {
          const btn = [...d.querySelectorAll('button')].find((b) => /continue|close|dismiss|×/i.test((b.getAttribute('aria-label') || '') + b.textContent))
          if (btn) btn.click()
        }
      })
      await page.waitForTimeout(450)
    }
  }

  await page.waitForTimeout(3200)
  await dismiss()
  await page.evaluate(() => { const n = [...document.querySelectorAll('button,a')].find((x) => (x.textContent || '').trim() === 'Todos'); if (n) n.click() })
  await page.waitForTimeout(1800)
  await dismiss()
  await page.evaluate(() => { for (const h of document.querySelectorAll('.gt-group-head button[aria-expanded="false"]')) h.click() })
  await page.waitForTimeout(700)

  const clip = { x: 250, y: 0, width: 1350, height: 1000 }
  await page.screenshot({ path: OUT + '/s1-list.png', clip })

  await page.locator('.gt-item').first().click({ force: true })
  await page.waitForTimeout(1400)
  await dismiss()
  const detail = page.locator('.gt-detail').first()
  if (await detail.count()) await detail.screenshot({ path: OUT + '/s2-detail.png' })

  const step3 = page.locator('.gt-step-check').nth(2)
  if (await step3.count()) { await step3.click({ force: true }); await page.waitForTimeout(900) }
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(700)
  if (await detail.count()) await detail.screenshot({ path: OUT + '/s3-steps.png' })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  const reviewTab = page.locator('.gt-tab', { hasText: /^Review 1$/ }).first()
  if (await reviewTab.count()) { await reviewTab.click({ force: true }); await page.waitForTimeout(1200) }
  await page.screenshot({ path: OUT + '/s4-review.png', clip })

  const allTab = page.locator('.gt-tab').first()
  if (await allTab.count()) { await allTab.click({ force: true }); await page.waitForTimeout(600) }
  const kebab = page.locator('.gt-head .gt-iconbtn').nth(1)
  if (await kebab.count()) {
    await kebab.click({ force: true })
    await page.waitForTimeout(800)
    const settings = page.getByText(/^Settings$/).first()
    if (await settings.count()) { await settings.click({ force: true }); await page.waitForTimeout(1500) }
  }
  await page.evaluate(() => { const el = document.querySelector('.gt-settings-path'); if (el) el.textContent = '~/.dsh/global-todo/todos.json' })
  await page.waitForTimeout(300)
  const card = page.locator('.gt-settings').first()
  if (await card.count()) await card.screenshot({ path: OUT + '/s5-settings.png' })
  await page.screenshot({ path: OUT + '/s5-frame.png', clip })

  await browser.close()
  for (const f of fs.readdirSync(OUT)) console.log(f, Math.round(fs.statSync(OUT + '/' + f).size / 1024) + 'KB')
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
