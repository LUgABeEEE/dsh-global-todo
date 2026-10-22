/**
 * The market index is generated (`tools/market.mjs`) and committed, so it can silently drift
 * from the release it describes. This is the guard: the newest version in the index must be the
 * version in package.json. Forgetting to regenerate after a release is the one mistake that
 * makes the index actively harmful — a reader would be offered an older build than npm has.
 *
 * The format itself is checked by the real validator in `tools/market.mjs` (borrowed from a DSH
 * profile); what is checked here must also hold on a machine with no profile installed.
 *
 * @module dsh-global-todo/test/market
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const index = JSON.parse(readFileSync(path.join(root, 'docs', 'market', 'index.json'), 'utf8'))

/** Newest-first, the same ordering the market reader computes for itself. */
function compare(left, right) {
  const parts = (value) => value.split('-', 1)[0].split('.').map(Number)
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < 3; i += 1) {
    const difference = (b[i] ?? 0) - (a[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

test('the market index declares format 1 and this plugin', () => {
  assert.equal(index.format, 1)
  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].name, pkg.name)
})

test('the market index offers the version package.json declares', () => {
  const newest = index.plugins[0].versions[0]
  assert.equal(newest.version, pkg.version, 'run npm run market after bumping the version')
})

test('every offered version is a published npm version, newest first', () => {
  const { versions } = index.plugins[0]
  assert.ok(versions.length > 0)
  for (const [position, entry] of versions.entries()) {
    assert.match(entry.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    assert.equal(entry.source.type, 'npm')
    assert.ok(Number.isInteger(entry.publishTimestamp) && entry.publishTimestamp > 0)
    if (position > 0) assert.ok(compare(versions[position - 1].version, entry.version) < 0, `${versions[position - 1].version} must come before ${entry.version}`)
  }
})

test('the icon stays on the site the index is served from', () => {
  const icon = index.plugins[0].icon
  assert.ok(icon.startsWith('../'), 'a relative reference keeps the icon valid on any host')
  const resolved = new URL(icon, 'https://lugabeeee.github.io/dsh-global-todo/market/index.json')
  assert.equal(resolved.href, 'https://lugabeeee.github.io/dsh-global-todo/icon.svg')
})
