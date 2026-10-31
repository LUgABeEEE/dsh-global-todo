#!/usr/bin/env node
/**
 * Static checks that need neither a browser, a host, nor a network.
 *
 * `npm test` proves behaviour; this proves the shipping shape. It runs before
 * the tests so an obvious mistake fails in a second, with a file name.
 *
 * Checks:
 *   1. every JavaScript file parses (via `node --check`, which handles both
 *      ES modules and classic scripts);
 *   2. every JSON file parses;
 *   3. nothing a commit would carry names a machine-local home path — a fixture,
 *      a test constant and a screenshot caption are published just as surely as
 *      the shipped halves, so the rule covers the whole tree;
 *   4. nothing a commit would carry contains obvious credential material;
 *   5. every tool schema is accepted by the Host's own validator, when this
 *      machine has a DSH profile to borrow it from (skipped elsewhere).
 *
 * @module dsh-global-todo/scripts/check
 */

import { execFile, execFileSync } from 'node:child_process'
import { auditClientCalls } from '../tools/scan-client-calls.mjs'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

/**
 * @param {string} message
 */
function fail(message) {
  failures.push(message)
  process.stderr.write(`FAIL  ${message}\n`)
}

/**
 * @param {string} relative
 * @returns {Promise<string[]>} every file below a directory (POSIX paths)
 */
async function walk(relative) {
  const out = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(child)))
    else out.push(child)
  }
  return out
}

const sources = [
  ...(await walk('lib')),
  ...(await walk('scripts')),
  ...(await walk('test')),
  ...(await walk('tools')),
  'package.json',
  'locale/zh.json',
  'locale/en.json',
]

for (const file of sources) {
  if (file.endsWith('.json')) {
    try {
      JSON.parse(await readFile(path.join(root, file), 'utf8'))
    } catch (error) {
      fail(`${file}: invalid JSON (${error.message})`)
    }
    continue
  }
  if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue
  try {
    await run(process.execPath, ['--check', path.join(root, file)])
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 3)
      .join(' | ')
    fail(`${file}: ${detail}`)
  }
}

// Shipping hygiene. The path rule is the one that actually bit this repository:
// the shipped halves were careful, while a preview fixture, a test constant and
// a screenshot caption each carried the author's real home — and all three are
// published. `/home/me` is the single documented placeholder, so it is the only
// home this allows; everything else looks like somebody's machine.
const MACHINE_PATH = /\/(?:home|Users)\/(?!me\/)[a-zA-Z0-9._-]+\//
// The same class of leak, in the two shapes the home rule above cannot see:
// a Windows profile path, and *this* checkout's own location. The first is a
// pattern; the second is computed, because a repository cannot know every
// machine's layout but it does know the one running the check. Both bit this
// repository for real — a demo seed and a restart instruction each shipped an
// absolute path while the shipped halves stayed clean.
const WINDOWS_MACHINE_PATH = /[A-Za-z]:\\Users\\(?!me\\)[A-Za-z0-9._-]+\\/
const LOCAL_ROOTS = [process.env.HOME, process.env.USERPROFILE, root]
  .filter((value) => typeof value === 'string' && value.length > 6)
  .map((value) => value.replace(/\/+$/, ''))

// Everything a commit would carry — asked of git rather than re-implemented.
// The hand-kept list this replaces drifted from .gitignore: local audit reports
// and AgentTeams state were ignored by git but still scanned, so a clean tree
// reported failures nobody could act on. git is the single source of truth; the
// walker below stays as a fallback for a checkout without it.
const FALLBACK_IGNORES = [
  /^\.git\//,
  /^node_modules\//,
  /^preview\//,
  /^\.agent-teams\//,
  /^reports\//,
  /\.bak-/,
  /\.tmp$/,
  /\.tgz$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /^\.idea\//,
  /^\.vscode\//,
  /(^|\/)todos\.json$/,
]

/** @returns {Promise<string[]>} every file a commit would include */
async function committable() {
  try {
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\0')
      .filter((file) => file !== '' && !file.endsWith('/'))
    if (listed.length > 0) return listed.sort()
  } catch {
    // No git here: fall through to the walker.
  }
  return walkIgnore('.')
}

/** The dependency-free fallback: the same rules, applied by hand. */
async function walkIgnore(relative) {
  const out = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative === '.' ? entry.name : path.posix.join(relative, entry.name)
    if (FALLBACK_IGNORES.some((pattern) => pattern.test(entry.isDirectory() ? `${child}/` : child))) continue
    if (entry.isDirectory()) out.push(...(await walkIgnore(child)))
    else out.push(child)
  }
  return out.sort()
}

// The rule a person would run by hand before committing. A leaked credential — or
// a leaked home directory — in a test or a doc is exactly as leaked as one in
// `lib/`, so the whole tree is checked, and the local artifacts that must never
// reach a commit are asserted absent rather than assumed.
const COMMIT_CREDENTIAL = /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/i
// The trailing newline is what makes a PEM header real — and what keeps this rule
// from matching its own source text.
const COMMIT_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n/
const MUST_NOT_COMMIT = [/^node_modules\//, /^preview\//, /(^|\/)todos\.json$/, /\.bak-/]
const committableFiles = await committable()
for (const file of committableFiles) {
  if (/\.(png|jpe?g|gif|ico|woff2?|zstd)$/i.test(file)) continue
  const text = await readFile(path.join(root, file), 'utf8')
  if (MACHINE_PATH.test(text) || WINDOWS_MACHINE_PATH.test(text)) {
    fail(`${file}: names a machine-local home path (use /home/me/… as the placeholder)`)
  }
  const local = LOCAL_ROOTS.find((prefix) => text.includes(prefix))
  if (local !== undefined) fail(`${file}: names a real filesystem location on this machine (${local})`)
  if (COMMIT_PRIVATE_KEY.test(text)) fail(`${file}: contains a private key block`)
  else if (COMMIT_CREDENTIAL.test(text)) fail(`${file}: contains what looks like a credential`)
}
for (const file of committableFiles) {
  if (MUST_NOT_COMMIT.some((pattern) => pattern.test(file))) {
    fail(`${file}: a local artifact would be committed (check .gitignore)`)
  }
}
process.stdout.write(`OK  ${committableFiles.length} committable files carry no credential, no home path and no local artifact\n`)


// The version the tree ships is written down in three places that cannot import each other:
// package.json (what npm publishes), lib/index.js (what the running module reports) and the
// landing page (what a reader is told). Only the first two were ever compared, and the third
// drifted: 0.22.0 shipped with "latest 0.21.0" on the site, which is the one surface a person
// reads before installing. A test cannot reach docs/, so the check does it here.
{
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const index = await readFile(path.join(root, 'docs', 'index.html'), 'utf8')
  const match = /<code>latest ([0-9]+\.[0-9]+\.[0-9]+)<\/code>/.exec(index)
  if (match === null) {
    fail('docs/index.html does not state a latest version (expected <code>latest X.Y.Z</code>)')
  } else if (match[1] !== pkg.version) {
    fail(`docs/index.html says latest ${match[1]}, but this tree is ${pkg.version} — update the card in the same commit as the bump`)
  }
}

// The Host's real validator, when a profile is available. Tool schemas that
// fall outside its subset are rejected at registration and the failure is
// quiet, so this is worth checking with the genuine article.
const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
const profileCandidates = ['web', 'desktop', 'headless']
let hostChecked = 'skipped (no DSH profile with @deepseek-ai/dsh-tools)'
for (const profile of profileCandidates) {
  const anchor = path.join(home, 'profiles', profile, 'package.json')
  if (!existsSync(anchor)) continue
  let validator
  try {
    const requireFromProfile = createRequire(anchor)
    validator = requireFromProfile('@deepseek-ai/dsh-tools')
  } catch {
    continue
  }
  if (typeof validator?.assertSupportedJsonSchema !== 'function') continue
  try {
    const { createTools } = await import('../lib/tools.js')
    const { createService } = await import('../lib/service.js')
    const { createStore } = await import('../lib/store.js')
    const service = createService({ store: createStore({ file: path.join(home, 'global-todo', 'todos.json') }) })
    let checked = 0
    for (const tool of createTools(service)) {
      for (const [label, schema] of [
        ['parameters', tool.parameters],
        ['output.schema', tool.output.schema],
      ]) {
        try {
          validator.assertObjectJsonSchema(schema)
          validator.assertSupportedJsonSchema(schema)
          checked += 1
        } catch (error) {
          fail(`${tool.name}.${label} rejected by the Host validator: ${error.message}`)
        }
      }
    }
    hostChecked = `${checked} schema(s) accepted via profile "${profile}"`
  } catch (error) {
    fail(`could not validate tool schemas against profile "${profile}": ${error.message}`)
  }
  break
}

// A call to a function nobody defined is invisible to every other check here, and it
// reaches a person as "the button errors" *after* the write succeeded.
{
  const clientSource = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  const undefinedCalls = auditClientCalls(clientSource)
  if (undefinedCalls.length > 0) {
    fail(`lib/client.js calls undefined function(s): ${undefinedCalls.join(', ')}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`)
  process.exit(1)
}

process.stdout.write(
  `OK  ${sources.length} files parsed, ${committableFiles.length} committable files clean, host validator: ${hostChecked}\n`,
)
