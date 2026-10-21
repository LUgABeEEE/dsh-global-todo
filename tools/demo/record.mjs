const fs = require('node:fs')
const { chromium } = require('/data/agent/.dsh/profiles/web/node_modules/playwright')

const token = fs.readFileSync('/tmp/dsh-demo.log', 'utf8').match(/token=([^\s]+)/)[1]
const OUT = '/tmp/demo-rec'
const W = 1440
const H = 900
const marks = {}
let t0 = 0
const at = (name) => { marks[name] = Math.round((Date.now() - t0) / 100) / 10 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ args: ['--no-sandbox', '--force-color-profile=srgb', '--hide-scrollbars'] })
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    colorScheme: 'light',
  })
  const page = await context.newPage()

  await context.addInitScript(() => {
    const boot = () => {
      const style = document.createElement('style')
      style.textContent = [
        '#demo-cursor{position:fixed;left:0;top:0;width:24px;height:24px;border-radius:50%;',
        'border:2px solid rgba(17,21,27,.8);background:rgba(255,255,255,.7);z-index:2147483647;',
        'pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 2px 10px rgba(0,0,0,.22);',
        'transition:width .1s ease,height .1s ease}',
        '.demo-ripple{position:fixed;width:16px;height:16px;border-radius:50%;border:2px solid rgba(17,21,27,.5);',
        'z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);animation:demo-rip .6s ease-out forwards}',
        '@keyframes demo-rip{to{width:60px;height:60px;opacity:0}}',
      ].join('')
      document.head.appendChild(style)
      const dot = document.createElement('div')
      dot.id = 'demo-cursor'
      dot.style.left = '50%'
      dot.style.top = '60%'
      document.body.appendChild(dot)
      window.addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px' }, true)
      window.addEventListener('mousedown', (e) => {
        const rip = document.createElement('div')
        rip.className = 'demo-ripple'
        rip.style.left = e.clientX + 'px'
        rip.style.top = e.clientY + 'px'
        document.body.appendChild(rip)
        setTimeout(() => rip.remove(), 650)
      }, true)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
    else boot()
  })

  t0 = Date.now()
  await page.goto('http://127.0.0.1:3099/?token=' + token, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2400)

  // Close any startup dialog (preview notice / get started).
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      const btn = [...d.querySelectorAll('button')].find((b) => /close|dismiss|×/i.test((b.getAttribute('aria-label') || '') + b.textContent))
      if (btn) btn.click()
    }
  })
  await page.waitForTimeout(500)

  // Open the panel the same way the sidebar does.
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button,a,[role="menuitem"]')]
    const target = nodes.find((n) => (n.textContent || '').trim() === 'Todos')
    if (target) target.click()
  })
  await page.waitForTimeout(1600)
  await page.evaluate(() => {
    for (const head of document.querySelectorAll('.gt-group-head button[aria-expanded="false"]')) head.click()
  })
  await page.waitForTimeout(700)
  at('scene1')

  const centerOf = async (handle) => handle.boundingBox()
  const moveTo = async (x, y) => { await page.mouse.move(x, y, { steps: 22 }); await page.waitForTimeout(220) }
  const moveToLocator = async (locator, dx = 0, dy = 0) => {
    const box = await locator.boundingBox()
    if (box === null) return false
    await moveTo(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy)
    return true
  }

  // 1 — the list
  const row1 = page.locator('.gt-item').first()
  await moveToLocator(row1, -120, 0)
  await page.waitForTimeout(1900)

  // 2 — open one row: evidence, steps, tick a step
  at('scene2')
  const title1 = page.locator('.gt-item-title').first()
  await moveToLocator(title1, -60, 0)
  await title1.click({ force: true })
  await page.waitForTimeout(1200)
  const step3 = page.locator('.gt-step-check').nth(2)
  if (await step3.count()) {
    await moveToLocator(step3)
    await step3.click({ force: true })
    await page.waitForTimeout(900)
  }
  await page.mouse.move(W * 0.55, H * 0.72, { steps: 18 })
  await page.waitForTimeout(2400)

  // 3 — hand-off and the row menu
  at('scene3')
  const handoff = page.locator('.gt-item').first().locator('button', { hasText: /Hand to/ }).first()
  if (await handoff.count()) { await moveToLocator(handoff); await page.waitForTimeout(900) }
  const kebab = page.locator('.gt-item').first().locator('.gt-iconbtn').first()
  if (await kebab.count()) {
    await moveToLocator(kebab)
    await kebab.click({ force: true })
    await page.waitForTimeout(1100)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(1600)

  // 4 — review: an agent's dones is a claim until a person answers
  at('scene4')
  const reviewTab = page.locator('.gt-tab', { hasText: /^Review 1$|^待确认 1$/ }).first()
  if (await reviewTab.count()) {
    await moveToLocator(reviewTab)
    await reviewTab.click({ force: true })
    await page.waitForTimeout(1500)
  }
  const confirm = page.locator('button', { hasText: /Confirm done|确认完成/ }).first()
  if (await confirm.count()) {
    await moveToLocator(confirm)
    await confirm.click({ force: true })
    await page.waitForTimeout(1600)
  }
  const allTab = page.locator('.gt-tab').first()
  if (await allTab.count()) { await moveToLocator(allTab); await allTab.click({ force: true }); await page.waitForTimeout(900) }
  await page.waitForTimeout(1500)

  // 5 — where the data lives
  at('scene5')
  const headKebab = page.locator('.gt-head .gt-iconbtn').nth(1)
  if (await headKebab.count()) {
    await moveToLocator(headKebab)
    await headKebab.click({ force: true })
    await page.waitForTimeout(800)
    const settingsItem = page.getByText(/^Settings$|^设置$/).first()
    if (await settingsItem.count()) {
      await moveToLocator(settingsItem)
      await settingsItem.click({ force: true })
      await page.waitForTimeout(2400)
      // This recording runs against a throwaway DSH_HOME under /tmp; the About row would
      // show that scratch path. Replace just that one string with the path a normal
      // install has, and keep replacing it for the length of the scene in case the card
      // re-renders. The video description says the path is illustrative.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const patched = await page.evaluate(() => {
          const el = document.querySelector('.gt-settings-path')
          if (el === null) return false
          el.textContent = '~/.dsh/global-todo/todos.json'
          el.setAttribute('title', '~/.dsh/global-todo/todos.json')
          return true
        })
        if (patched) await page.waitForTimeout(250)
        else await page.waitForTimeout(120)
      }
      console.log('path patched:', await page.textContent('.gt-settings-path').catch(() => 'n/a'))
    }
  }
  await page.waitForTimeout(3000)

  // 6 — settle for the call to action
  at('scene6')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await moveTo(W * 0.5, H * 0.86)
  await page.waitForTimeout(3200)
  at('end')

  await context.close()
  await browser.close()
  const video = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'))
  fs.writeFileSync(OUT + '/marks.json', JSON.stringify({ marks, video: OUT + '/' + video }, null, 1))
  console.log(JSON.stringify({ video: OUT + '/' + video, marks, bytes: fs.statSync(OUT + '/' + video).size }))
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
