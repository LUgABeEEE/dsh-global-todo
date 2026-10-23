/**
 * The market index is generated (`tools/market.mjs`) from the **registry** and committed, so it
 * can silently drift from the release it describes.
 *
 * The offline rule is one-directional on purpose: the index may not offer a version newer than
 * this tree, but it may lag by exactly the release in flight. A version bump happens before
 * `npm publish`, so a strict equality test would fail between the bump and the publish — and
 * because `prepack` runs the suite, that failure would block publishing entirely (it did: the
 * first release after this file landed could not be tagged).
 *
 * "Is the index stale?" is a question about the registry, so it is answered by
 * `npm run market:fresh`, which fetches and compares. That one belongs after the publish.
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

test('the market index never offers a version newer than this tree', () => {
  const newest = index.plugins[0].versions[0]
  assert.ok(
    compare(newest.version, pkg.version) >= 0,
    `the index offers ${newest.version}, but this tree is ${pkg.version}: it cannot describe a build that does not exist yet`,
  )
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

test('the offline rule is one-directional, so a release can be published', () => {
  // Guard against the strict-equality rule creeping back: equality cannot hold between the
  // version bump and its publish, and `prepack` runs this suite — a strict test makes the
  // release unpublishable. Freshness is `npm run market:fresh` (network).
  const newest = index.plugins[0].versions[0]
  assert.ok(compare(newest.version, pkg.version) >= 0)
  assert.equal(typeof pkg.scripts['market:fresh'], 'string', 'the registry check has to exist somewhere')
})
