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
 *   3. the shipped halves contain no machine-local absolute paths;
 *   4. the shipped halves contain no obvious credential material;
 *   5. every tool schema is accepted by the Host's own validator, when this
 *      machine has a DSH profile to borrow it from (skipped elsewhere).
 *
 * @module dsh-global-todo/scripts/check
 */

import { execFile } from 'node:child_process'
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

// Shipping hygiene, applied to the files that actually reach a user.
const shipped = [...(await walk('lib')), ...(await walk('locale')), 'cordis.patch.yml']
const FORBIDDEN = [
  { pattern: /\/(home|Users)\/[a-zA-Z0-9._-]+\//, why: 'a machine-local home path' },
  { pattern: /\/data\/agent\//, why: 'a machine-local workspace path' },
  {
    pattern: /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    why: 'what looks like a credential',
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n/, why: 'a private key' },
]
for (const file of shipped) {
  const text = await readFile(path.join(root, file), 'utf8')
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) fail(`${file}: contains ${rule.why}`)
  }
}

// Everything a first commit would carry, with the same exclusions `.gitignore`
// applies. The credential rule below used to run only on shipped files, which
// left tests, tools and docs — all of them published to GitHub — unchecked.
const IGNORED_FROM_COMMIT = [
  // The repository metadata is not committable content, and scanning git's own
  // objects would invite false positives from compressed bytes.
  /^\.git\//,
  /^node_modules\//,
  /^preview\//,
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
async function committable(relative = '.') {
  const out = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative === '.' ? entry.name : path.posix.join(relative, entry.name)
    if (IGNORED_FROM_COMMIT.some((pattern) => pattern.test(entry.isDirectory() ? `${child}/` : child))) continue
    if (entry.isDirectory()) out.push(...(await committable(child)))
    else out.push(child)
  }
  return out
}

// The rule a person would run by hand before committing. A leaked credential in a
// test or a doc is exactly as leaked as one in `lib/`, so the whole tree is
// checked, and the local artifacts that must never reach a commit are asserted
// absent rather than assumed.
const COMMIT_CREDENTIAL = /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/i
// The trailing newline is what makes a PEM header real — and what keeps this rule
// from matching its own source text.
const COMMIT_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n/
const MUST_NOT_COMMIT = [/^node_modules\//, /^preview\//, /(^|\/)todos\.json$/, /\.bak-/]
const committableFiles = await committable()
for (const file of committableFiles) {
  if (/\.(png|jpe?g|gif|ico|woff2?|zstd)$/i.test(file)) continue
  const text = await readFile(path.join(root, file), 'utf8')
  if (COMMIT_PRIVATE_KEY.test(text)) fail(`${file}: contains a private key block`)
  else if (COMMIT_CREDENTIAL.test(text)) fail(`${file}: contains what looks like a credential`)
}
for (const file of committableFiles) {
  if (MUST_NOT_COMMIT.some((pattern) => pattern.test(file))) {
    fail(`${file}: a local artifact would be committed (check .gitignore)`)
  }
}
process.stdout.write(`OK  ${committableFiles.length} committable files carry no credential and no local artifact\n`)

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
  `OK  ${sources.length} files parsed, ${shipped.length} shipped files clean, host validator: ${hostChecked}\n`,
)
