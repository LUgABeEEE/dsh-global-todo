/**
 * Manifest integrity: the four files that must agree for the package to load.
 *
 * A plugin fails in a way that is hard to diagnose when `package.json`, the
 * bundle patch, the client entry and the locale metadata disagree, so each
 * agreement is asserted here rather than discovered in a browser console.
 */

import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')
const exists = async (relative) => {
  try {
    await stat(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

const manifest = JSON.parse(await read('package.json'))
const patch = await read('cordis.patch.yml')
const entry = await read('lib/index.js')

test('the package id is used consistently everywhere the loader looks', () => {
  assert.equal(manifest.name, 'dsh-global-todo')
  assert.match(patch, new RegExp(`name: '${manifest.name}'`))
  assert.match(entry, /export const name = 'dsh-global-todo'/)
})

test('the declared version matches the one the code reports', () => {
  const declared = /export const VERSION = '([^']+)'/.exec(entry)?.[1]
  assert.equal(declared, manifest.version, 'lib/index.js VERSION and package.json version must agree')
})

test('the patch contributes exactly one loader row and no personal paths', () => {
  const inserts = patch.match(/^\s*- insert:/gm) ?? []
  assert.equal(inserts.length, 1)
  assert.match(patch, /- id: global-todo/)
  assert.doesNotMatch(patch, /\/home\/|\/Users\/|\/data\//, 'the shipped patch must not carry machine-local paths')
})

test('the exports map points at files that exist', async () => {
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  for (const target of [manifest.exports['.'], manifest.exports['./client']]) {
    assert.equal(await exists(target.replace(/^\.\//, '')), true, `${target} is missing`)
  }
})

test('the client half is declared for the web platform', () => {
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('every published file is listed and present', async () => {
  for (const required of ['lib', 'locale', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.en.md', 'README.zh.md', 'CHANGELOG.md']) {
    assert.ok(manifest.files.includes(required), `${required} must be published`)
  }
  // The desktop Host resolves `<pkg>/locale/en.json` through `exports` and then scans that
  // directory. A package that advertises the export but omits the folder makes the Host
  // report "Plugin metadata … ENOENT … locale" — a real report from a hand-copied
  // plugins-local install. Keep both halves of that contract asserted.
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'the locale export feeds the plugins page')
  assert.ok(manifest.files.includes('locale'), 'locale/ must ship or the export points at nothing')

  // A leading `!` is an exclusion, not a file: the landing page and the demo video are
  // built for the web (GitHub Pages) and deliberately kept out of the npm tarball.
  for (const published of manifest.files.filter((entry) => !entry.startsWith('!'))) {
    assert.equal(await exists(published), true, `${published} is listed but missing`)
  }
  assert.ok(!manifest.files.includes('test'), 'tests are not part of the published package')
})

test('the plugin ships with no runtime dependencies', () => {
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.type, 'module')
})

test('the floors npm enforces are the ones the docs promise', async () => {
  // A review once suggested lowering engines.node to >=18 to "avoid runtime failures on legacy
  // LTS". That is backwards: the Host's Web profile itself needs Node >= 22.19.0, so a lower
  // floor only moves the failure from install time to startup. This test pins the decision in
  // both directions — the floor stays high enough to be true, and both READMEs quote the same
  // numbers, so a well-meant "quick patch" cannot quietly lower it or leave the docs behind.
  const floor = manifest.engines.node
  const version = floor.replace(/^[^0-9]*/, '')
  const major = Number.parseInt(version, 10)
  assert.ok(Number.isInteger(major) && major >= 22, `engines.node is ${floor}; the Web profile needs 22.19 or newer, and 18/20 are EOL`)
  assert.match(version, /^22\.19\./, 'the floor is the profile requirement, not a rounder number')

  for (const doc of ['README.md', 'README.en.md']) {
    const text = await read(doc)
    assert.ok(text.includes(version), `${doc} does not state the Node floor ${version}`)
    assert.ok(text.includes(manifest.engines.dsh), `${doc} does not quote the DSH range ${manifest.engines.dsh}`)
  }
  assert.equal(manifest.license, 'MIT')
})

test('both locale files describe the plugin for the plugins page', async () => {
  for (const locale of ['zh', 'en']) {
    const file = JSON.parse(await read(`locale/${locale}.json`))
    assert.equal(typeof file.meta.title, 'string')
    assert.ok(file.meta.title.length > 1)
    assert.equal(typeof file.meta.description, 'string')
    assert.ok(file.meta.description.length > 10)
  }
})

test('the scripts a contributor needs are declared', () => {
  assert.equal(manifest.scripts.test, 'node --test "test/**/*.test.mjs"')
  assert.ok(manifest.scripts.check)
  assert.ok(manifest.scripts.verify)
})

test('the license file is the one the manifest claims', async () => {
  const license = await read('LICENSE')
  assert.match(license, /^MIT License/)
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/)
})
