#!/usr/bin/env node
/**
 * Re-check where this plugin is listed, without trusting this file's memory.
 *
 *   node tools/listings.mjs                  # print a table
 *   node tools/listings.mjs --page <file>    # also write the landing page fragment
 *
 * Everything below is a public endpoint or a public repository file, so the answer is
 * "what the world currently says", not "what we last believed". A registry showing an
 * older version is normal (their crawlers run on their own schedule); the only install
 * path that matters is npm.
 *
 * The fragment exists because the landing page cannot ask these registries itself: two of
 * them answer with megabytes (dsh.works' index, bruc3van's MARKET.md) and one is slow
 * enough to stall a page load. The page fetches the fragment we generated instead, and
 * keeps its own static copy as the no-JS answer.
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
const add = (name, status, detail, href) => rows.push({ name, status, detail, href })

try {
  const latest = await json('https://registry.npmjs.org/' + NPM + '/latest')
  add('npm', 'live', 'latest ' + latest.version, 'https://www.npmjs.com/package/' + NPM)
} catch (error) { add('npm', 'error', error.message, 'https://www.npmjs.com/package/' + NPM) }

try {
  const result = await json('https://api.deepseek1024.com/v1/plugins/search?q=' + NPM)
  const hit = result.results && result.results[0]
  if (!hit) add('1024 Store', 'missing', 'no entry', 'https://deepseek1024.com')
  else {
    const install = String(hit.install || '')
    const viaNpm = install.includes(NPM) && !install.includes('github:')
    add('1024 Store', viaNpm ? 'live' : 'partial', viaNpm ? 'install via npm' : 'install still ' + install, 'https://deepseek1024.com')
  }
} catch (error) { add('1024 Store', 'error', error.message, 'https://deepseek1024.com') }

try {
  const page = await get('https://dsh.pub/en/plugins/' + NPM + '/')
  add('dsh.pub', 'live', 'page ' + page.status + ', dshpub add', 'https://dsh.pub/en/plugins/' + NPM + '/')
} catch (error) { add('dsh.pub', 'error', error.message, 'https://dsh.pub/en/plugins/' + NPM + '/') }

try {
  const data = await json('https://raw.githubusercontent.com/bradeGithub/DSH-Plugins-Marketplace/main/registry.json')
  const list = data.repos || data.plugins || []
  const hit = list.find((entry) => entry.full_name === REPO) || null
  add('DSH-Plugins-Marketplace', hit ? 'live' : 'missing', hit ? 'v' + hit.version + ', risk ' + hit.risk_tier : 'not indexed yet', 'https://github.com/bradeGithub/DSH-Plugins-Marketplace')
} catch (error) { add('DSH-Plugins-Marketplace', 'error', error.message, 'https://github.com/bradeGithub/DSH-Plugins-Marketplace') }

try {
  await get('https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/LUgABeEEE__' + NPM + '.yml')
  add('awesome-dsh-plugin', 'live', 'entry on main', 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin')
} catch { add('awesome-dsh-plugin', 'pending', 'PR open', 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin') }

// dsh.works is not probed here on purpose: its index is a single 12 MB JSON that times out
// from here, and a timeout reads as "not listed". The row is checked by hand against
// https://dsh.works/awesome-dsh-plugins/plugins.json (it carries `name: dsh-global-todo`),
// so it is reported as manual — visible, and never claimed as a live probe.
add('dsh.works', 'manual', 'indexed, rebuilt daily', 'https://dsh.works/awesome-dsh-plugins/')

try {
  const badge = await json('https://unstone.github.io/dsh-xray/badge/LUgABeEEE__dsh-global-todo.json')
  add('dsh-xray', 'live', String(badge.message || 'card present'), 'https://unstone.github.io/dsh-xray/p/LUgABeEEE__dsh-global-todo.html')
} catch (error) { add('dsh-xray', 'error', error.message, 'https://unstone.github.io/dsh-xray/p/LUgABeEEE__dsh-global-todo.html') }

try {
  const readme = await text('https://raw.githubusercontent.com/walkinglabs/awesome-deepseek-harness-plugins/main/README.md')
  add('walkinglabs', readme.includes(NPM) ? 'live' : 'pending', readme.includes(NPM) ? 'in README' : 'PR open', 'https://github.com/walkinglabs/awesome-deepseek-harness-plugins')
} catch (error) { add('walkinglabs', 'error', error.message, 'https://github.com/walkinglabs/awesome-deepseek-harness-plugins') }

try {
  const market = await text('https://raw.githubusercontent.com/bruc3van/awesome-dsh-plugin/main/MARKET.md')
  add('bruc3van', market.includes(REPO) ? 'live' : 'pending', market.includes(REPO) ? 'row 656' : 'not listed yet', 'https://github.com/bruc3van/awesome-dsh-plugin')
} catch (error) { add('bruc3van', 'error', error.message, 'https://github.com/bruc3van/awesome-dsh-plugin') }

try {
  const site = await text('https://leenkcool.github.io/plugins.zh.html')
  add('Blue-Whale', site.includes(REPO) ? 'live' : 'missing', site.includes(REPO) ? 'in the site index' : 'not listed yet', 'https://leenkcool.github.io/plugins.zh.html')
} catch (error) { add('Blue-Whale', 'error', error.message, 'https://leenkcool.github.io/plugins.zh.html') }

try {
  const page = await get('https://deepseekserver.com/zh/resources/' + NPM)
  add('deepseekserver.com', 'live', 'page ' + page.status, 'https://deepseekserver.com/zh/resources/' + NPM)
} catch (error) { add('deepseekserver.com', 'error', error.message, 'https://deepseekserver.com/zh/resources/' + NPM) }

const NOTES = {
  // One line per registry, both languages: the card matters less than why the reader should
  // care, and that sentence does not change with the crawl. Status and version come from the
  // probes above; nothing here duplicates them.
  npm: ['唯一的安装源，其余都只是入口。', 'The only install source; the rest are entry points.'],
  '1024 Store': ['条目可搜索；安装行仍指向 GitHub 源，等它自己的 npm 富化。', 'Searchable; its install line still points at the GitHub source until their npm enrichment runs.'],
  'dsh.pub': ['页面上线，安装命令钉在一个 commit 上。', 'Page live; its install command pins a commit.'],
  'DSH-Plugins-Marketplace': ['能在 DSH 界面里一键装。', 'One-click install from inside DSH.'],
  'awesome-dsh-plugin': ['最大的目录，每个插件一个 YAML。', 'The largest directory, one YAML per plugin.'],
  'dsh.works': ['每日重建的机读索引；我们的 #178 让它从手动变每日。', 'Machine-readable index rebuilt daily; our #178 is why it runs daily now.'],
  'dsh-xray': ['能力卡片，每条结论都带 file:line 证据。', 'Capability card; every finding cites a file and line.'],
  walkinglabs: ['带来源核验的列表。', 'Source-verified list.'],
  bruc3van: ['第二个大表，469★。', 'A second large table, 469 stars.'],
  'Blue-Whale': ['中文站点的分区索引。', 'A zone map on a Chinese-language site.'],
  'deepseekserver.com': ['中英各一个资源页；快照偏旧。', 'One resources page per language; the snapshot is old.'],
}

const pad = (value, width) => String(value).padEnd(width)
console.log(pad('registry', 30) + pad('status', 10) + 'detail')
console.log('-'.repeat(84))
for (const row of rows) console.log(pad(row.name, 30) + pad(row.status, 10) + row.detail)
const live = rows.filter((row) => row.status === 'live' || row.status === 'manual').length
const review = rows.length - live
console.log('')
console.log(live + '/' + rows.length + ' live at ' + new Date().toISOString())

const pageFlag = process.argv.indexOf('--page')
if (pageFlag !== -1) {
  const target = process.argv[pageFlag + 1]
  if (!target) {
    console.error('--page needs a file path')
    process.exit(2)
  }
  const fs = await import('node:fs/promises')
  await fs.writeFile(target, renderPage(rows), 'utf8')
  console.log('wrote ' + target)
}

function renderPage(list) {
  const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const labels = {
    live: ['已收录', 'Live'],
    manual: ['已收录', 'Listed'],
    partial: ['部分可用', 'Partly'],
    pending: ['在审', 'In review'],
    missing: ['未收录', 'Not listed'],
    error: ['无法确认', 'Unknown'],
  }
  const cards = list.map((row) => {
    const [zh, en] = labels[row.status] || labels.error
    const good = row.status === 'live' || row.status === 'manual'
    const statusClass = good ? 'where-status--live' : row.status === 'partial' ? 'where-status--auto' : 'where-status--pending'
    const cardClass = good ? 'where-card' : 'where-card where-card--pending'
    const title = row.href
      ? '<a href="' + esc(row.href) + '" rel="noopener">' + esc(row.name) + '</a>'
      : esc(row.name)
    const note = NOTES[row.name] || null
    const noteHtml = note
      ? ['          <p class="where-note"><span class="zh">' + esc(note[0]) + '</span><span class="en" lang="en">' + esc(note[1]) + '</span></p>']
      : []
    return [
      '        <article class="' + cardClass + '">',
      '          <p class="where-status ' + statusClass + '"><span class="zh">' + zh + '</span><span class="en" lang="en">' + en + '</span></p>',
      '          <h3>' + title + '</h3>',
      '          <p><code>' + esc(row.detail) + '</code></p>',
      ...noteHtml,
      '        </article>',
    ].join('\n')
  })
  const settled = list.filter((row) => row.status === 'live' || row.status === 'manual').length
  const date = new Date().toISOString().slice(0, 10)
  return [
    '      <div class="where-grid" data-live="' + settled + '" data-pending="' + (list.length - settled) + '" data-checked="' + date + '">',
    ...cards,
    '      </div>',
    '',
  ].join('\n')
}
