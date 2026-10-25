#!/usr/bin/env node
/**
 * Panel screenshots.
 *
 * The three images under docs/screenshots/ ship with the package and are embedded in
 * both READMEs, so they have to be *reproducible* rather than hand-made. This tool
 * photographs the static previews that tools/preview.mjs renders, at the viewport the
 * committed images use, with the browser Playwright already put on the machine.
 *
 *   npm run screenshots                 # render the previews, then photograph them
 *   node tools/screenshot.mjs           # photograph what preview/ already holds
 *   node tools/screenshot.mjs --out DIR # write the PNGs somewhere else
 *
 * Playwright is deliberately *not* a dependency: the plugin itself needs no browser,
 * so the copy the DSH profile installed is borrowed instead. Without a profile, a
 * plain `playwright` package on the module path is used.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The viewport the committed screenshots were taken at; changing it re-crops every README. */
const VIEWPORT = { width: 1280, height: 720 }

/** preview/<name>.html → <out>/<name>.png, in the order the READMEs mention them. */
const SHOTS = [
  'panel',
  'panel-detail',
  'panel-select',
  'panel-settings',
  // One image per state that has no other baseline: empty list, filter with no match,
  // inbox, due reminder. See the scenario table in tools/preview.mjs.
  'panel-empty',
  'panel-filtered',
  'panel-inbox',
  'panel-review',
  'panel-reminders',
]

function flagValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a directory`)
  return value
}

/** The phone preset: its own directory, its own viewport, its own images. */
const MOBILE = {
  viewport: { width: 390, height: 844 },
  shots: ['panel', 'panel-detail', 'panel-settings'],
  out: path.join(root, 'docs', 'screenshots', 'mobile'),
}

const OUT_DIR = path.resolve(flagValue('--out') ?? path.join(root, 'docs', 'screenshots'))
const PREVIEW_DIR = path.join(root, 'preview')
const MOBILE_MODE = process.argv.includes('--mobile')

/**
 * Load Playwright from the DSH profile, or from anywhere it happens to be installed.
 *
 * @returns {Promise<{chromium: object}>}
 */
async function loadPlaywright() {
  if (process.env.DSH_PLAYWRIGHT !== undefined && process.env.DSH_PLAYWRIGHT !== '') {
    return await importCjs(pathToFileURL(process.env.DSH_PLAYWRIGHT).href)
  }
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  for (const profile of ['web', 'desktop', 'headless']) {
    const anchor = path.join(home, 'profiles', profile, 'package.json')
    if (existsSync(anchor) === false) continue
    try {
      // Playwright is CommonJS: require() it, so the caller gets the same object a
      // plain require would, instead of an ESM namespace with it under .default.
      return createRequire(anchor)('playwright')
    } catch {
      // No Playwright in this profile; the next one may have it.
    }
  }
  try {
    return await importCjs('playwright')
  } catch {
    throw new Error(
      'playwright not found: install it, or point DSH_PLAYWRIGHT at an existing install',
    )
  }
}

/**
 * import() a CommonJS package and hand back the object its own callers would see.
 *
 * @param {string} specifier
 * @returns {Promise<object>}
 */
async function importCjs(specifier) {
  const namespace = await import(specifier)
  return namespace.chromium === undefined ? (namespace.default ?? namespace) : namespace
}

const missing = SHOTS.filter((name) => existsSync(path.join(PREVIEW_DIR, `${name}.html`)) === false)
if (missing.length > 0) {
  console.error(`preview/${missing[0]}.html is missing — run: npm run preview`)
  process.exit(1)
}

const { chromium } = await loadPlaywright()
mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch()
try {
  if (MOBILE_MODE) {
    // A phone screenshot is viewport-shaped on purpose: what the phone shows, not the
    // whole document. The detail state lives below the fold, so that one is scrolled to
    // the open row first — a picture of the top of the list would not show the detail.
    const page = await browser.newPage({ viewport: MOBILE.viewport, deviceScaleFactor: 2 })
    mkdirSync(MOBILE.out, { recursive: true })
    for (const name of MOBILE.shots) {
      const source = path.join(PREVIEW_DIR, 'mobile', `${name}.html`)
      if (existsSync(source) === false) {
        console.error(`preview/mobile/${name}.html is missing — run: node tools/preview.mjs --mobile`)
        process.exit(1)
      }
      const target = path.join(MOBILE.out, `${name}.png`)
      await page.goto(pathToFileURL(source).href, { waitUntil: 'load' })
      await page.waitForFunction(() => document.styleSheets.length > 0)
      if (name === 'panel-detail') {
        await page.evaluate(() => {
          const open = document.querySelector('.gt-item[data-open="1"]')
          // The row *starts* the picture: its title and the first fields are the part a
          // reader needs to see, and centring pushed them above the fold.
          if (open !== null) open.scrollIntoView({ block: 'start' })
        })
      }
      await page.screenshot({ path: target })
      const bytes = readFileSync(target).length
      console.log(`${path.relative(root, target)}  ${MOBILE.viewport.width}x${MOBILE.viewport.height}  ${bytes} B`)
    }
    console.log(`wrote ${MOBILE.shots.length} mobile screenshot(s) to ${path.relative(root, MOBILE.out)}`)
    process.exit(0)
  }
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  for (const name of SHOTS) {
    const source = path.join(PREVIEW_DIR, `${name}.html`)
    const target = path.join(OUT_DIR, `${name}.png`)
    await page.goto(pathToFileURL(source).href, { waitUntil: 'load' })
    // The previews are static once loaded, but the panel's own stylesheet has to have
    // been applied before the first frame is worth keeping.
    await page.waitForFunction(() => document.styleSheets.length > 0)
    await page.screenshot({ path: target })
    const bytes = readFileSync(target).length
    console.log(`${path.relative(root, target)}  ${VIEWPORT.width}x${VIEWPORT.height}  ${bytes} B`)
  }
} finally {
  await browser.close()
}
console.log(`wrote ${SHOTS.length} screenshot(s) to ${path.relative(root, OUT_DIR) || '.'}`)
