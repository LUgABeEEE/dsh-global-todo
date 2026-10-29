import assert from 'node:assert/strict'
import test from 'node:test'

import { TOMBSTONE_TTL_MS, forgetTombstone, mergeDocuments, normalizeTrash, pushTombstone } from '../lib/replica.js'

/**
 * Realistic epoch milliseconds.
 *
 * A tombstone is pruned once it is older than the retention window, so a test written with
 * `updatedAt: 1000` is testing the pruning rule by accident — the fold would drop the very
 * mark under test. Every timestamp below is "now, plus a few milliseconds", and the folds
 * that care about retention pass `now` explicitly.
 */
const BASE = 1_790_000_000_000

/** A record with just the fields the fold reads. */
function todo(id, updatedAt, extra = {}) {
  return { id, title: id, seq: 0, createdAt: BASE - 10_000, updatedAt, ...extra }
}

test('the newer copy of one record wins, whichever side it is on', () => {
  const older = { todos: [todo('t-a', BASE, { title: '旧标题' })], trash: [] }
  const newer = { todos: [todo('t-a', BASE + 1000, { title: '新标题' })], trash: [] }

  assert.equal(mergeDocuments(older, newer).todos[0].title, '新标题')
  assert.equal(mergeDocuments(newer, older).todos[0].title, '新标题')
})

test('the fold is commutative: the same set gives the same list from either side', () => {
  const left = {
    todos: [todo('t-a', BASE), todo('t-b', BASE + 500, { title: '左' })],
    trash: [{ id: 't-gone', at: BASE + 200, by: 'human' }],
  }
  const right = {
    todos: [todo('t-b', BASE + 400, { title: '右' }), todo('t-c', BASE + 600), todo('t-gone', BASE - 100)],
    trash: [],
  }

  const forward = mergeDocuments(left, right)
  const backward = mergeDocuments(right, left)
  assert.deepEqual(forward.todos, backward.todos)
  assert.deepEqual(forward.trash, backward.trash)
  assert.equal(forward.stats.total, 3)
})

test('folding a document with itself changes nothing (idempotent)', () => {
  const doc = {
    todos: [todo('t-a', BASE), todo('t-b', BASE + 1000)],
    trash: [{ id: 't-z', at: BASE + 500, by: 'agent' }],
  }
  const once = mergeDocuments(doc, doc)
  const twice = mergeDocuments(once, once)
  assert.deepEqual(twice.todos, once.todos)
  assert.deepEqual(twice.trash, once.trash)
  assert.equal(once.stats.added + once.stats.updated + once.stats.removed, 0)
})

test('a deletion at or after the last edit removes the record', () => {
  const local = { todos: [todo('t-a', BASE), todo('t-b', BASE)], trash: [] }
  const other = {
    todos: [todo('t-a', BASE - 500), todo('t-b', BASE - 500)],
    trash: [
      { id: 't-a', at: BASE, by: 'human' },
      { id: 't-b', at: BASE - 100, by: 'human' },
    ],
  }
  const merged = mergeDocuments(local, other)
  assert.deepEqual(
    merged.todos.map((entry) => entry.id),
    ['t-b'],
    'a delete at the same millisecond wins, an older delete does not',
  )
  assert.equal(merged.stats.removed, 1)
})

test('an edit made after the deletion brings the record back', () => {
  const edited = { todos: [todo('t-a', BASE + 1000)], trash: [] }
  const deleted = { todos: [], trash: [{ id: 't-a', at: BASE, by: 'human' }] }
  const merged = mergeDocuments(edited, deleted, { now: BASE + 2000 })
  assert.deepEqual(
    merged.todos.map((entry) => entry.id),
    ['t-a'],
    'a deliberate edit after the delete is the later fact',
  )
  assert.equal(merged.trash.length, 1, 'the tombstone stays, so older copies are still deleted')
})

test('two machines that both handed out #2 are renumbered the same way on both sides', () => {
  const first = {
    todos: [todo('t-a', BASE, { seq: 1, createdAt: BASE - 300 }), todo('t-b', BASE, { seq: 2, createdAt: BASE - 200 })],
    trash: [],
  }
  const second = {
    todos: [todo('t-c', BASE, { seq: 1, createdAt: BASE - 300 }), todo('t-d', BASE, { seq: 2, createdAt: BASE - 100 })],
    trash: [],
  }

  const forward = mergeDocuments(first, second)
  const backward = mergeDocuments(second, first)
  const numbers = new Map(forward.todos.map((entry) => [entry.id, entry.seq]))
  assert.deepEqual(new Map(backward.todos.map((entry) => [entry.id, entry.seq])), numbers)
  assert.equal(new Set([...numbers.values()]).size, numbers.size, 'no two records share a number')
  assert.equal(numbers.get('t-b'), 2, 'the earlier record keeps the number a person already saw')
  assert.equal(forward.stats.duplicates, 2)
})

test('the order is a function of the records, not of which side was read first', () => {
  const early = todo('t-z', BASE, { createdAt: BASE - 200 })
  const late = todo('t-a', BASE, { createdAt: BASE - 100 })
  const forward = mergeDocuments({ todos: [early, late], trash: [] }, { todos: [], trash: [] })
  const backward = mergeDocuments({ todos: [], trash: [] }, { todos: [late, early], trash: [] })
  assert.deepEqual(forward.todos.map((entry) => entry.id), ['t-z', 't-a'])
  assert.deepEqual(backward.todos.map((entry) => entry.id), ['t-z', 't-a'])
})

test('a tombstone expires after the retention window and is dropped', () => {
  const now = BASE + 10 * TOMBSTONE_TTL_MS
  const old = { id: 't-old', at: now - TOMBSTONE_TTL_MS - 1000, by: 'human' }
  const fresh = { id: 't-new', at: now - 1000, by: 'human' }
  const merged = mergeDocuments({ todos: [], trash: [old, fresh] }, { todos: [], trash: [] }, { now })
  assert.deepEqual(merged.trash.map((entry) => entry.id), ['t-new'])
})

test('the tombstone list is bounded, newest kept', () => {
  const trash = [1, 2, 3, 4].map((index) => ({ id: 't-' + index, at: BASE + index, by: 'human' }))
  const merged = mergeDocuments({ todos: [], trash }, { todos: [], trash: [] }, { now: BASE + 10_000, tombstoneLimit: 2 })
  assert.deepEqual(merged.trash.map((entry) => entry.id), ['t-4', 't-3'])
})

test('one id deleted twice keeps the later deletion', () => {
  const normalized = normalizeTrash([
    { id: 't-a', at: 100, by: 'human' },
    { id: 't-a', at: 300, by: 'agent' },
    { id: '', at: 200 },
    { id: 't-b', at: 'nonsense' },
  ])
  assert.deepEqual(normalized, [{ id: 't-a', at: 300, by: 'agent' }])
})

test('undoing a deletion takes the mark away, and only that one', () => {
  const trash = [
    { id: 't-a', at: 100, by: 'human' },
    { id: 't-b', at: 200, by: 'human' },
  ]
  assert.deepEqual(forgetTombstone(trash, 't-a').map((entry) => entry.id), ['t-b'])
  assert.deepEqual(pushTombstone(trash, { id: 't-c', at: 300 }).map((entry) => entry.id), ['t-c', 't-b', 't-a'])
})

test('records without a number are numbered by creation, on both sides', () => {
  const merged = mergeDocuments(
    {
      todos: [todo('t-a', BASE, { createdAt: BASE - 100 }), todo('t-b', BASE, { createdAt: BASE - 300 })],
      trash: [],
    },
    { todos: [todo('t-c', BASE, { createdAt: BASE - 200 })], trash: [] },
  )
  assert.deepEqual(
    merged.todos.map((entry) => [entry.id, entry.seq]),
    [
      ['t-b', 1],
      ['t-c', 2],
      ['t-a', 3],
    ],
  )
})

test('an empty side is not a deletion: the fold keeps what it has', () => {
  const merged = mergeDocuments({ todos: [todo('t-a', BASE)], trash: [] }, { todos: [], trash: [] })
  assert.equal(merged.todos.length, 1)
  assert.equal(merged.stats.removed, 0)
})

test('a document from an older version (no trash array) is read, not refused', () => {
  const merged = mergeDocuments({ todos: [todo('t-a', BASE)] }, null)
  assert.equal(merged.todos.length, 1)
  assert.deepEqual(merged.trash, [])
})
