#!/usr/bin/env node
/**
 * Is anyone actually using this plugin?
 *
 * npm reports one number and no names, and a single spike is ambiguous: a mirror backfilling a
 * new package, a supply-chain scanner walking every version, and a real audience all look alike
 * in `downloads`. The shape is what tells them apart:
 *
 *   - **automated** — downloads cluster on one day, spread across every version published in that
 *     day's burst (a crawler pulls each new version once), older versions sit at a flat baseline,
 *     and the repository's own traffic does not move.
 *   - **real** — downloads concentrate on the newest version or two, and stars, issues and views
 *     move in the same week.
 *
 *   npm run usage:check
 *   node tools/usage-check.mjs --json
 *
 * Public APIs only: npm's download endpoints and the unauthenticated GitHub repository endpoint.
 * Nothing here identifies a person, and nothing is stored.
 *
 * Caveat this tool cannot remove: a plugin installed from a git source never reaches npm, so a
 * zero here is "nobody installed from npm", not "nobody uses it".
 *
 * @module dsh-global-todo/tools/usage-check
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const repo = 'LUgABeEEE/dsh-global-todo'
const days = Number(process.argv.find((arg) => arg.startsWith('--days='))?.slice(7) ?? 14)
const json = process.argv.includes('--json')

const get = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `${pkg.name}-usage-check` },
  })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  return response.json()
}

const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
const to = new Date().toISOString().slice(0, 10)

const [range, versions, repository] = await Promise.all([
  get(`https://api.npmjs.org/downloads/range/${from}:${to}/${pkg.name}`),
  get(`https://api.npmjs.org/versions/${pkg.name}/last-week`),
  get(`https://api.github.com/repos/${repo}`).catch(() => null),
])

const daily = (range.downloads ?? []).filter((day) => day.downloads > 0)
const total = daily.reduce((sum, day) => sum + day.downloads, 0)
const peak = daily.reduce((best, day) => (best === null || day.downloads > best.downloads ? day : best), null)
const perVersion = Object.entries(versions.downloads ?? {}).sort((left, right) => right[1] - left[1])

const concentration = total === 0 || peak === null ? 0 : peak.downloads / total
const newestShare = total === 0 || perVersion.length === 0 ? 0 : perVersion[0][1] / perVersion.reduce((sum, [, count]) => sum + count, 0)

let shape = 'no downloads in the window'
if (total > 0 && concentration >= 0.6) {
  shape = perVersion.length >= 4 && newestShare < 0.4
    ? 'automated — one day, spread evenly across the versions published that day, no version dominant'
    : 'one burst — check whether stars and views moved the same week'
} else if (total > 0) {
  shape = 'spread over several days — the shape real usage has'
}

const report = {
  package: pkg.name,
  window: { from, to },
  downloads: {
    total,
    daysWithTraffic: daily.length,
    peak: peak === null ? null : { day: peak.day, count: peak.downloads },
  },
  topVersions: perVersion.slice(0, 8).map(([version, count]) => ({ version, count })),
  stars: repository?.stargazers_count ?? null,
  forks: repository?.forks_count ?? null,
  openIssues: repository?.open_issues_count ?? null,
  shape,
}

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write(`usage:check  ${pkg.name}  (${from} … ${to})\n`)
  process.stdout.write(`  downloads ${String(total)} across ${String(daily.length)} day(s)\n`)
  if (peak !== null) process.stdout.write(`  peak      ${peak.day} = ${String(peak.downloads)}\n`)
  for (const [version, count] of perVersion.slice(0, 8)) {
    process.stdout.write(`    ${version.padEnd(9)} ${String(count)}\n`)
  }
  process.stdout.write(`  github    stars ${String(report.stars ?? '?')} · forks ${String(report.forks ?? '?')} · open issues ${String(report.openIssues ?? '?')}\n`)
  process.stdout.write(`\n  shape: ${shape}\n`)
  process.stdout.write('  note: a git-source install never reaches npm — zero here means "nobody installed from npm"\n')
}
