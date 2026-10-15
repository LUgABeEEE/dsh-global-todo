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
const SHOTS = ['panel', 'panel-detail', 'panel-select']

function flagValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a directory`)
  return value
}

const OUT_DIR = path.resolve(flagValue('--out') ?? path.join(root, 'docs', 'screenshots'))
const PREVIEW_DIR = path.join(root, 'preview')

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
