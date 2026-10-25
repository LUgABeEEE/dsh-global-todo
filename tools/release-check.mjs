#!/usr/bin/env node
/**
 * Release cadence check.
 *
 * Seven releases went out between 12:22 and 20:04 on 2026-10-22, and the catalog every
 * reader browses rebuilds **once a day**: it was still offering 0.12.13 two days later.
 * A version nobody can find is a version nobody installs, so the cadence is part of the
 * distribution problem, not a private preference.
 *
 *   npm run release:check          # is now a good moment?
 *   node tools/release-check.mjs --json
 *
 * Exit codes follow the convention this repository already uses for dsh-restart-guard, so
 * a caller can branch on them without parsing prose:
 *
 *   0   nothing pending, or the window is open — release when you like
 *   10  a release went out recently and only ordinary work is waiting — hold it
 *   20  nothing releasable since the last tag — there is no release to cut
 *
 * A data-loss or security fix ignores this tool: shipping that an hour late is worse than
 * shipping it twice in a day. The tool reports, it does not forbid.
 *
 * @module dsh-global-todo/tools/release-check
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The catalog every DSH market reads rebuilds around 04:2x UTC — publish *before* it. */
const CATALOG_HOUR_UTC = 4
/** A day minus the catalog's rebuild slack, so one release per day can still catch a rebuild. */
const MIN_HOURS_BETWEEN_RELEASES = 20
/** Conventional-commit types that are worth their own version. */
const RELEASABLE = ['feat', 'fix', 'perf', 'refactor', 'revert']

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const json = process.argv.includes('--json')

/**
 * Registry mode — what the publish workflow needs.
 *
 * A tag checkout is one commit deep, so `git describe --tags` cannot answer "when did we last
 * publish". npm can: the packument's `time` map lists every version with its publish moment,
 * which also makes this the only check that measures the real thing (a release that failed to
 * publish never reaches npm, so the tag alone would understate the gap).
 */
async function registryReport() {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`)
  if (!response.ok) throw new Error(`registry answered ${String(response.status)}`)
  const packument = await response.json()
  const times = Object.fromEntries(
    Object.entries(packument.time ?? {}).filter(([key]) => key !== 'created' && key !== 'modified'),
  )
  const published = times[pkg.version]
  if (published !== undefined) {
    return { version: pkg.version, alreadyPublished: published, exit: 20, verdict: `${pkg.version} is already on npm — bump the version first` }
  }
  const previous = Object.entries(times)
    .filter(([version]) => version !== pkg.version)
    .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]))[0]
  if (previous === undefined) {
    return { version: pkg.version, previous: null, exit: 0, verdict: 'nothing is published yet' }
  }
  const [previousVersion, previousAt] = previous
  const hours = (Date.now() - Date.parse(previousAt)) / 3600000
  const exit = hours < MIN_HOURS_BETWEEN_RELEASES ? 10 : 0
  return {
    version: pkg.version,
    previous: previousVersion,
    previousAt,
    hoursSinceRelease: Number(hours.toFixed(1)),
    exit,
    verdict: exit === 10
      // Name the workflow's own input, not an older name for it: a person who follows this
      // message and asks for "hotfix" finds no such input and cannot ship the fix it is for.
      ? `${previousVersion} went out ${hours.toFixed(1)} h ago — hold this one for the daily window (workflow_dispatch with force=true for a data-loss or security fix)`
      : `${previousVersion} is ${hours.toFixed(1)} h old — the cadence allows this release`,
  }
}

if (process.argv.includes('--registry')) {
  const report = await registryReport()
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`release:check --registry  ${pkg.version}\n`)
    if (report.previous !== undefined && report.previous !== null) {
      process.stdout.write(`  previous ${report.previous} at ${report.previousAt} — ${String(report.hoursSinceRelease)} h ago\n`)
    }
    process.stdout.write(`\n  ${report.verdict}\n`)
  }
  process.exit(report.exit)
}

let lastTag = ''
try {
  lastTag = git('describe', '--tags', '--abbrev=0')
} catch {
  lastTag = ''
}

const since = lastTag === '' ? '' : `${lastTag}..HEAD`
const log = since === ''
  ? git('log', '--format=%H%x1f%cI%x1f%s')
  : git('log', '--format=%H%x1f%cI%x1f%s', since)

const commits = log.split('\n').filter((line) => line !== '').map((line) => {
  const [sha, date, subject] = line.split('\x1f')
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: (?<text>.*)$/u.exec(subject)
  return {
    sha: sha.slice(0, 7),
    date,
    subject,
    type: match?.groups?.type ?? 'other',
    scope: match?.groups?.scope ?? '',
    breaking: match?.groups?.breaking === '!',
    text: match?.groups?.text ?? subject,
  }
})

const releasable = commits.filter((commit) => RELEASABLE.includes(commit.type) || commit.breaking)

let hoursSinceRelease = null
let releasedAt = null
if (lastTag !== '') {
  releasedAt = git('log', '-1', '--format=%cI', lastTag)
  hoursSinceRelease = (Date.now() - new Date(releasedAt).getTime()) / 3600000
}

const nowUtcHour = new Date().getUTCHours()
const windowOpen = nowUtcHour >= CATALOG_HOUR_UTC

let code = 0
let verdict = ''
if (releasable.length === 0) {
  code = 20
  verdict = lastTag === ''
    ? 'nothing has been committed yet'
    : `nothing releasable since ${lastTag} — only docs/chore/test work is waiting`
} else if (hoursSinceRelease !== null && hoursSinceRelease < MIN_HOURS_BETWEEN_RELEASES) {
  code = 10
  verdict = `${lastTag} is ${hoursSinceRelease.toFixed(1)} h old — hold these ${String(releasable.length)} change(s) for the daily window`
} else if (!windowOpen) {
  code = 0
  verdict = `the catalog rebuilds at 0${String(CATALOG_HOUR_UTC)}:2x UTC; publishing now means waiting for tomorrow's rebuild`
} else {
  verdict = 'the window is open and the last release is old enough'
}

const report = {
  version: pkg.version,
  lastTag: lastTag === '' ? null : lastTag,
  releasedAt,
  hoursSinceRelease: hoursSinceRelease === null ? null : Number(hoursSinceRelease.toFixed(1)),
  commitsSinceTag: commits.length,
  releasable: releasable.map((commit) => `${commit.type}${commit.breaking ? '!' : ''}: ${commit.text}`),
  other: commits.filter((commit) => !releasable.includes(commit)).map((commit) => `${commit.type}: ${commit.text}`),
  catalogRebuildsAtUtc: `0${String(CATALOG_HOUR_UTC)}:2x`,
  exit: code,
  verdict,
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write(`release:check  ${pkg.version}  (last tag ${report.lastTag ?? 'none'})\n`)
  if (report.hoursSinceRelease !== null) {
    process.stdout.write(`  released ${report.releasedAt} — ${String(report.hoursSinceRelease)} h ago\n`)
  }
  process.stdout.write(`  ${String(commits.length)} commit(s) since, ${String(releasable.length)} releasable\n`)
  for (const line of report.releasable) process.stdout.write(`    · ${line}\n`)
  for (const line of report.other) process.stdout.write(`    - ${line}\n`)
  process.stdout.write(`  catalog rebuilds at ${report.catalogRebuildsAtUtc} UTC (Beijing 12:2x)\n`)
  process.stdout.write(`\n  ${verdict}\n`)
}

process.exit(code)
