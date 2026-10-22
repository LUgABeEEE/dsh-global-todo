/**
 * Build the plugin market index for this plugin.
 *
 * DSH's Discover tab reads one JSON index from a URL a user adds by hand, and ships none of
 * its own. Publishing our own means a reader who already found the plugin can install it with
 * one click instead of copying a command and restarting the host — the step where every visit
 * has been dying (9 visitors, 0 installs on 2026-10-21).
 *
 *   npm run market                 # writes docs/market/index.json
 *   node tools/market.mjs --check  # validate the committed file, write nothing
 *
 * The format is dsh's plugin market index format 1. `@deepseek-ai/dsh-plugin-market-index`
 * is the executable rule set, and it is borrowed from the installed DSH profile the same way
 * tools/screenshot.mjs borrows playwright: this plugin has no dependencies of its own, and a
 * market index the reader refuses is worse than no index at all. Without a profile the file is
 * still written, with the validation skipped loudly.
 *
 * What is listed: every published version that declares `dsh.bundle.patch` and is not
 * deprecated — the same rule the reference generator uses. Versions published before the
 * bundle declaration existed are left out, because dsh refuses to install anything else.
 *
 * @module dsh-global-todo/tools/market
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'docs', 'market', 'index.json')
const PACKAGE = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Where the index will live once Pages serves it; relative icons resolve against it. */
const INDEX_URL = 'https://lugabeeee.github.io/dsh-global-todo/market/index.json'
const REGISTRY = 'https://registry.npmjs.org'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

/** Borrow the validator from a DSH profile, the way tools/screenshot.mjs borrows playwright. */
function loadValidator() {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  for (const profile of ['web', 'desktop', 'headless']) {
    const anchor = path.join(home, 'profiles', profile, 'package.json')
    if (existsSync(anchor) === false) continue
    try {
      return createRequire(anchor)('@deepseek-ai/dsh-plugin-market-index')
    } catch {
      // The next profile may carry it.
    }
  }
  return null
}

/** npm returns ISO timestamps; format 1 wants integer Unix seconds. */
const toSeconds = (iso) => Math.floor(new Date(iso).getTime() / 1000)

/** `dsh.bundle.patch` is a string or an array of strings; anything else is not a bundle. */
function declaresBundle(manifest) {
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch === 'string') return patch.trim() !== ''
  return Array.isArray(patch) && patch.length > 0 && patch.every((entry) => typeof entry === 'string' && entry.trim() !== '')
}

async function fetchPackument(name) {
  const response = await fetch(`${REGISTRY}/${name}`)
  if (!response.ok) throw new Error(`${REGISTRY}/${name} answered ${String(response.status)}`)
  return response.json()
}

/**
 * Order two versions newest-first without a semver dependency.
 *
 * The first attempt compared the strings, which put 0.9.1 above 0.16.2 — the market reader
 * sorts the list itself, so the file would still have worked, but a human reading it (and the
 * "newest" line this tool prints) would have been lied to. Every version here is a plain
 * x.y.z, so numeric segments are enough; a prerelease is ordered below its release.
 */
function compareVersions(left, right) {
  const split = (value) => {
    const [core, prerelease] = value.split('-', 2)
    return { parts: core.split('.').map(Number), prerelease: prerelease === undefined ? null : prerelease }
  }
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (b.parts[index] ?? 0) - (a.parts[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return -1
  if (b.prerelease === null) return 1
  return a.prerelease < b.prerelease ? 1 : -1
}

function build(packument) {
  const times = packument.time ?? {}
  const versions = []
  for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
    if (manifest.deprecated !== undefined) continue
    if (!declaresBundle(manifest)) continue
    const published = times[version]
    if (published === undefined) continue
    const range = manifest.engines?.dsh
    const entry = {
      version,
      publishTimestamp: toSeconds(published),
      source: { type: 'npm' },
      ...typeof range === 'string' && range.trim() !== '' ? { engines: { dsh: range } } : {},
    }
    versions.push(entry)
  }
  if (versions.length === 0) throw new Error('no published version declares dsh.bundle.patch')
  versions.sort((left, right) => compareVersions(left.version, right.version))

  return {
    format: 1,
    title: { en: 'dsh-global-todo', zh: '全局待办' },
    description: {
      en: 'Global, cross-session todo list where a person and an agent write to the same items: each entry records when it was added, accepts attached documents and links, and can be handed to an agent session as a numbered plan. An agent marking an item done is a claim until a person confirms it.',
      zh: '人与 Agent 共用同一份跨会话待办清单：每条记录加入时间，可挂文档与地址，可带步骤计划并一键交给 Agent 会话继续处理；Agent 标记完成只是声明，要人确认才算完成。',
    },
    metadata: {
      categories: {
        tools: { title: { en: 'Tools & Capabilities', zh: '工具与能力' } },
      },
      labels: {
        'cross-session': { title: { en: 'Cross-session', zh: '跨会话' } },
        'human-in-the-loop': { title: { en: 'Human in the loop', zh: '需要人确认' } },
        'single-file': { title: { en: 'Single JSON file', zh: '单个 JSON 文件' } },
      },
      sortKeys: {
        stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
      },
    },
    plugins: [
      {
        name: PACKAGE.name,
        title: { en: 'Global Todo', zh: '全局待办' },
        description: {
          en: 'One JSON list a person and an agent both write to, with creation time, attachments, step plans and a confirmation gate on "done".',
          zh: '人和 Agent 读写同一份 JSON 清单，带加入时间、附件、步骤计划，以及「完成」需人确认的门。',
        },
        icon: '../icon.svg',
        author: 'LUgABeEEE',
        homepage: 'https://lugabeeee.github.io/dsh-global-todo/',
        repository: { url: 'https://github.com/LUgABeEEE/dsh-global-todo' },
        metadata: {
          category: 'tools',
          keywords: ['todo', 'task', 'cross-session', 'agent', 'deepseek-harness', 'dsh-plugin'],
          labels: ['cross-session', 'human-in-the-loop', 'single-file'],
        },
        versions,
      },
    ],
  }
}

const validator = loadValidator()
if (validator === null) {
  console.warn('market: no DSH profile found; validation skipped — install DSH or set DSH_HOME before publishing')
}

if (checkOnly) {
  if (!existsSync(OUT)) throw new Error(`${path.relative(root, OUT)} does not exist; run npm run market`)
  const committed = JSON.parse(readFileSync(OUT, 'utf8'))
  if (validator !== null) validator.parseMarketIndex(committed, INDEX_URL)
  console.log(`market: ${path.relative(root, OUT)} is valid, ${String(committed.plugins[0].versions.length)} version(s)`)
} else {
  const packument = await fetchPackument(PACKAGE.name)
  const index = build(packument)
  if (validator !== null) validator.parseMarketIndex(index, INDEX_URL)
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`market: wrote ${path.relative(root, OUT)}`)
  console.log(`  ${String(index.plugins[0].versions.length)} version(s), newest ${index.plugins[0].versions[0].version}`)
  console.log(`  validator: ${validator === null ? 'skipped' : 'accepted'}`)
}
