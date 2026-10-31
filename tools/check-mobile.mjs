#!/usr/bin/env node
/**
 * The phone contract, measured instead of assumed.
 *
 * `npm run check:render` proves the narrow branch exists and that the desktop render is
 * unchanged, all from static HTML. It cannot prove a thumb can hit anything: a stylesheet can say
 * `min-height: 44px` about the wrong element, or expand a hit area with a pseudo-element that
 * `getBoundingClientRect` does not report. Both happened here on 2026-10-31 — the search field was
 * a 20px box inside a 44px frame, and four controls kept a 29px height that the CSS contract was
 * happy with.
 *
 * So this walks the rendered phone views in a real browser and probes outward from each control's
 * centre until the point stops resolving to it. That is the measurement a thumb makes.
 *
 *   npm run check:mobile            # needs preview/mobile/*.html (npm run preview:mobile)
 *
 * Playwright is borrowed, not a dependency — the same rule as tools/screenshot.mjs. Without it this
 * script says so and exits 0, because a checkout with no browser should not look like a failure.
 *
 * What it cannot prove, and does not claim: the soft keyboard's effect on the viewport, the real
 * `env(safe-area-inset-*)` numbers, momentum scrolling, or line breaks at the largest system font.
 *
 * @module dsh-global-todo/check-mobile
 */
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREVIEW_DIR = path.join(root, 'preview', 'mobile')

/** The viewport the phone baselines are taken at; the same one this measures. */
const VIEWPORT = { width: 390, height: 844 }

/**
 * Tall enough that every control is on screen: `elementFromPoint` answers null outside the
 * viewport, which would read as "no hit area" and is not what we measure.
 */
const MEASURE_HEIGHT = 2400

/** The three phone views, and what each one is for. */
const VIEWS = [
  { file: 'panel.html', label: 'list' },
  { file: 'panel-detail.html', label: 'detail' },
  { file: 'panel-settings.html', label: 'settings' },
]

/** The smallest target a thumb can hit, and the narrowest a control may be. */
const MIN_HEIGHT = 44
const MIN_WIDTH = 24

async function loadPlaywright() {
  if (process.env.DSH_PLAYWRIGHT !== undefined && process.env.DSH_PLAYWRIGHT !== '') {
    return await importCjs(pathToFileURL(process.env.DSH_PLAYWRIGHT).href)
  }
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  for (const profile of ['web', 'desktop', 'headless']) {
    const anchor = path.join(home, 'profiles', profile, 'package.json')
    if (existsSync(anchor) === false) continue
    try {
      return createRequire(anchor)('playwright')
    } catch {
      /* next profile */
    }
  }
  try {
    return await importCjs('playwright')
  } catch {
    return null
  }
}

/** @param {string} specifier */
async function importCjs(specifier) {
  const namespace = await import(specifier)
  return namespace.chromium === undefined ? (namespace.default ?? namespace) : namespace
}

/**
 * Probe one element's real hit area.
 *
 * Kept as a string because it runs in the page, not here.
 *
 * @returns {Promise<{tag: string, className: string, name: string, visual: string, hit: string}[]>}
 */
const PROBE = () => {
  const rows = []
  const seen = new Set()
  const sheet = document.querySelector('.gt-settings')
  const scope = sheet ?? document
  for (const element of scope.querySelectorAll('button, a[href], input, select, textarea, [role="button"], label')) {
    const box = element.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    // A small checkbox inside its label is the documented pattern: the label is the target.
    if (element.tagName === 'INPUT' && element.type === 'checkbox' && element.closest('label') !== null) continue
    // A field caption is not a control; the input under it is the target and is measured itself.
    if (element.tagName === 'LABEL' && element.classList.contains('gt-field-label')) continue
    const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 24)
    const key = element.tagName + '|' + element.className + '|' + name
    if (seen.has(key)) continue
    seen.add(key)
    const owns = (x, y) => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (hit === element || element.contains(hit))
    }
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const reach = (dx, dy) => {
      let last = 0
      for (let step = 1; step <= 30; step += 1) {
        if (!owns(cx + dx * step, cy + dy * step)) return last
        last = step
      }
      return last
    }
    rows.push({
      tag: element.tagName.toLowerCase(),
      className: String(element.className).slice(0, 32),
      name,
      visual: Math.round(box.width) + 'x' + Math.round(box.height),
      hitWidth: reach(-1, 0) + reach(1, 0) + 1,
      hitHeight: reach(0, -1) + reach(0, 1) + 1,
    })
  }
  return rows
}

/**
 * The static half: what the stylesheet promises.
 *
 * These are the checklist items a render cannot show — a safe area only a real phone has, a type
 * variable only the host sets — so they are read from the CSS the client ships.
 *
 * @returns {string[]} failures
 */
function checkStyles() {
  const source = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  const start = source.indexOf('const CSS = `')
  const css = source.slice(start + 'const CSS = `'.length, source.indexOf('`', start + 'const CSS = `'.length))
  const failures = []
  const expect = (condition, message) => {
    if (condition !== true) failures.push(message)
  }
  expect(/safe-area-inset-bottom/.test(css), 'the bottom safe area is ignored: the last row sits under the home indicator')
  expect(/var\(--dsh-content-font-size/.test(css), "the panel ignores the host's text-size setting")
  expect(/overscroll-behavior:\s*contain/.test(css), 'scroll chaining is unguarded: momentum can carry the page behind the panel')
  expect(
    /\.gt-root\[data-mobile="1"\] \.gt-toolbar-main > \.gt-tabs\s*\{[^}]*overflow-x:\s*auto/.test(css),
    'the filter chips do not scroll sideways, so their tail is unreachable',
  )
  expect(
    /\.gt-root\[data-mobile="1"\] \.gt-btn-label\s*\{[^}]*display:\s*none/.test(css),
    'inline action labels do not collapse, so they eat the title line',
  )
  expect(
    /\.gt-root\[data-mobile="1"\] \.gt-new-fields \.gt-field-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    'two-column form rows are not collapsed to one column',
  )
  expect(
    /\.gt-root\[data-mobile="1"\] \.gt-search input/.test(css),
    'the search field itself is not sized for a thumb (the frame was, the field was not)',
  )
  return failures
}

/**
 * A desktop render that carries the phone attribute means the measurement was ignored — the same
 * layout decision was taken at 1280px as at 390px. The inlined stylesheet contains the selector
 * text, so it is stripped first: this asks about the markup, not about the CSS.
 *
 * @returns {string[]} failures
 */
function checkDesktopMarkup() {
  const file = path.join(root, 'preview', 'panel.html')
  if (existsSync(file) === false) return []
  const html = readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>/gi, '')
  return html.includes('data-mobile="1"')
    ? ['the desktop render carries data-mobile="1": the phone branch is being taken at 1280px']
    : []
}

const missing = VIEWS.map((view) => view.file).filter((file) => existsSync(path.join(PREVIEW_DIR, file)) === false)
if (missing.length > 0) {
  console.error(`preview/mobile/${missing[0]} is missing — run: npm run preview:mobile`)
  process.exit(1)
}

const playwright = await loadPlaywright()
const staticFailures = [...checkStyles(), ...checkDesktopMarkup()]
if (staticFailures.length > 0) {
  console.error('mobile contract:')
  for (const failure of staticFailures) console.error(' -', failure)
  process.exit(1)
}
if (playwright === null) {
  console.log('mobile contract (styles only): ok — playwright not found, so the hit areas were not measured')
  process.exit(0)
}

const browser = await playwright.chromium.launch()
const failures = []
try {
  for (const view of VIEWS) {
    const page = await browser.newPage({ viewport: { width: VIEWPORT.width, height: MEASURE_HEIGHT }, deviceScaleFactor: 1 })
    await page.goto(pathToFileURL(path.join(PREVIEW_DIR, view.file)).href, { waitUntil: 'load' })
    await page.waitForTimeout(300)
    const rows = await page.evaluate(PROBE)
    for (const row of rows) {
      if (row.hitHeight < MIN_HEIGHT || row.hitWidth < MIN_WIDTH) {
        failures.push(
          `${view.label}: ${row.tag}.${row.className || '(no class)'} "${row.name}" — visual ${row.visual}, hit ${row.hitWidth}x${row.hitHeight}`,
        )
      }
    }
    const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (width > 0) failures.push(`${view.label}: the page scrolls sideways by ${width}px`)
    await page.close()
  }
} finally {
  await browser.close()
}

if (failures.length > 0) {
  console.error(`mobile contract: ${failures.length} control(s) under ${MIN_HEIGHT}px:`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log(`mobile contract: ok — ${VIEWS.length} phone views, every target at least ${MIN_HEIGHT}x${MIN_WIDTH}px`)
