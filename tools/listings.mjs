#!/usr/bin/env node
/**
 * Re-check where this plugin is listed, without trusting this file's memory.
 *
 *   node tools/listings.mjs
 *
 * Everything below is a public endpoint or a public repository file, so the answer is
 * "what the world currently says", not "what we last believed". A registry showing an
 * older version is normal (their crawlers run on their own schedule); the only install
 * path that matters is npm.
 */

const NPM = 'dsh-global-todo'
const REPO = 'LUgABeEEE/dsh-global-todo'

const get = async (url) => {
  // A registry that cannot answer in 25s is "unknown", not "listed": never let a crawl hang.
  const response = await fetch(url, {
    headers: { 'user-agent': 'dsh-global-todo-listings' },
    signal: AbortSignal.timeout(25000),
  })
  if (!response.ok) throw new Error(response.status + ' ' + url)
  return response
}
const json = async (url) => (await get(url)).json()
const text = async (url) => (await get(url)).text()

const rows = []
const add = (name, status, detail) => rows.push({ name, status, detail })

try {
  const latest = await json('https://registry.npmjs.org/' + NPM + '/latest')
  add('npm', 'live', 'latest ' + latest.version)
} catch (error) { add('npm', 'error', error.message) }

try {
  const result = await json('https://api.deepseek1024.com/v1/plugins/search?q=' + NPM)
  const hit = result.results && result.results[0]
  if (!hit) add('1024 Store', 'missing', 'no entry')
  else {
    const install = String(hit.install || '')
    const viaNpm = install.includes(NPM) && !install.includes('github:')
    add('1024 Store', viaNpm ? 'live' : 'partial', viaNpm ? 'install via npm' : 'install still ' + install)
  }
} catch (error) { add('1024 Store', 'error', error.message) }

try {
  const page = await get('https://dsh.pub/en/plugins/' + NPM + '/')
  add('dsh.pub', 'live', 'page ' + page.status + ', dshpub add')
} catch (error) { add('dsh.pub', 'error', error.message) }

try {
  const data = await json('https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/registry.json')
  const list = data.repos || data.plugins || []
  const hit = list.find((entry) => entry.full_name === REPO) || null
  add('DSH-Plugins-Marketplace', hit ? 'live' : 'missing', hit ? 'v' + hit.version + ', risk ' + hit.risk_tier : 'not indexed yet')
} catch (error) { add('DSH-Plugins-Marketplace', 'error', error.message) }

try {
  await get('https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/LUgABeEEE__' + NPM + '.yml')
  add('awesome-dsh-plugin (19.7k)', 'live', 'entry on main')
} catch { add('awesome-dsh-plugin (19.7k)', 'pending', 'PR open') }

try {
  const readme = await text('https://raw.githubusercontent.com/walkinglabs/awesome-deepseek-harness-plugins/main/README.md')
  add('walkinglabs', readme.includes(NPM) ? 'live' : 'pending', readme.includes(NPM) ? 'in README' : 'PR open')
} catch (error) { add('walkinglabs', 'error', error.message) }

const pad = (value, width) => String(value).padEnd(width)
console.log(pad('registry', 30) + pad('status', 10) + 'detail')
console.log('-'.repeat(84))
for (const row of rows) console.log(pad(row.name, 30) + pad(row.status, 10) + row.detail)
const live = rows.filter((row) => row.status === 'live').length
console.log('')
console.log(live + '/' + rows.length + ' live at ' + new Date().toISOString())
