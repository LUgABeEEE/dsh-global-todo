import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { INBOX_TAG, expiredInbox, isInbox, normalizeIngestItem } from '../lib/ingest.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

test('an external item must name a source and state a confidence', () => {
  assert.match(normalizeIngestItem({ title: 'x', source: { kind: 'sms' }, confidence: 0.9 }).error, /source.kind/)
  assert.match(normalizeIngestItem({ title: 'x', source: { kind: 'mail' }, confidence: 2 }).error, /confidence/)
  assert.match(normalizeIngestItem({ title: '  ', source: { kind: 'mail' }, confidence: 0.9 }).error, /title/)
})

test('confidence decides list or inbox, and provenance is kept as a tag', () => {
  const high = normalizeIngestItem({ title: '交报告', source: { kind: 'mail', id: 'm1' }, confidence: 0.95 })
  assert.equal(high.inbox, false)
  assert.deepEqual(high.item.tags, ['source:mail'])
  const low = normalizeIngestItem({ title: '可能要去开会', source: { kind: 'notification' }, confidence: 0.4 })
  assert.equal(low.inbox, true)
  assert.deepEqual(low.item.tags, [INBOX_TAG, 'source:notification'])
})

test('only active records expire, and only after the window', () => {
  const base = { tags: [INBOX_TAG], status: 'open', createdAt: NOW - 8 * DAY }
  assert.equal(isInbox(base), true)
  assert.equal(expiredInbox([base], { now: NOW, days: 7 }).length, 1)
  assert.equal(expiredInbox([{ ...base, createdAt: NOW - 2 * DAY }], { now: NOW, days: 7 }).length, 0)
  assert.equal(expiredInbox([{ ...base, status: 'done' }], { now: NOW, days: 7 }).length, 0)
  assert.equal(expiredInbox([{ ...base, status: 'archived' }], { now: NOW, days: 7 }).length, 0)
  assert.equal(expiredInbox([{ ...base, tags: ['other'] }], { now: NOW, days: 7 }).length, 0)
})

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-ingest-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false } })
  return { dir, store, service, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('ingest writes through the service and reports what it refused', async () => {
  const env = await harness()
  try {
    await env.service.create({ title: '交实验报告' }, { by: 'human' })
    const result = await env.service.ingest(
      [
        { title: '交实验报告', source: { kind: 'mail' }, confidence: 0.9 },
        { title: '', source: { kind: 'mail' }, confidence: 0.9 },
        { title: '准备周四组会材料', source: { kind: 'mail' }, confidence: 0.4 },
        { title: '续借图书', source: { kind: 'notification' }, confidence: 0.9 },
      ],
      { confirmBelow: 0.8 },
    )
    assert.equal(result.created.length, 2)
    assert.ok(result.created.some((todo) => isInbox(todo)))
    assert.ok(!result.created.some((todo) => isInbox(todo) && todo.title.includes('图书')))
    assert.equal(result.skipped.length, 2)
    assert.ok(result.skipped.some((item) => item.reason === 'same-active'))
    assert.ok(result.skipped.some((item) => item.reason === 'invalid'))
  } finally {
    await env.cleanup()
  }
})

test('a dry run reports what would happen and writes nothing', async () => {
  const env = await harness()
  try {
    const result = await env.service.ingest(
      [{ title: '明天交材料', source: { kind: 'announcement' }, confidence: 0.5 }],
      { dryRun: true, confirmBelow: 0.8 },
    )
    assert.equal(result.created.length, 0)
    assert.equal(result.preview.length, 1)
    assert.equal(result.preview[0].inbox, true)
    assert.equal((await env.service.list({ status: 'all' })).todos.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('expireInbox archives stale unconfirmed records and leaves the rest', async () => {
  const env = await harness()
  try {
    const stale = await env.service.create({ title: '旧收件', tags: [INBOX_TAG] }, { by: 'agent' })
    const fresh = await env.service.create({ title: '新收件', tags: [INBOX_TAG] }, { by: 'agent' })
    // Backdate the record on disk: the service always stamps `now`, and the rule under test
    // is about age.
    const file = path.join(env.dir, 'todos.json')
    const { readFile, writeFile } = await import('node:fs/promises')
    const doc = JSON.parse(await readFile(file, 'utf8'))
    for (const todo of doc.todos) {
      if (todo.id === stale.id) todo.createdAt = NOW - 9 * DAY
    }
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`)
    const result = await env.service.expireInbox({ days: 7 })
    assert.equal(result.expired, 1)
    assert.equal((await env.service.get(stale.id)).status, 'archived')
    assert.equal((await env.service.get(fresh.id)).status, 'open')
  } finally {
    await env.cleanup()
  }
})
