import { strict as assert } from 'node:assert'
import test from 'node:test'

import { TodoError } from '../lib/errors.js'
import {
  LIMITS,
  PRIORITIES,
  addNote,
  PRIORITY_LABELS,
  addLink,
  applyPatch,
  completeTodo,
  counts,
  createTodo,
  isOverdue,
  newId,
  normalizeDue,
  normalizeStored,
  normalizeTags,
  pushActivity,
  recordDispatch,
  removeLink,
  setStatus,
} from '../lib/model.js'

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)

test('a new todo records who added it and when', () => {
  const todo = createTodo({ title: '  交周报  ', links: ['https://example.com/report'] }, { now: NOW, by: 'agent' })
  assert.equal(todo.title, '交周报')
  assert.equal(todo.createdAt, NOW)
  assert.equal(todo.updatedAt, NOW)
  assert.equal(todo.createdBy, 'agent')
  assert.equal(todo.status, 'open')
  assert.equal(todo.priority, 'normal')
  assert.equal(todo.dueAt, null)
  assert.equal(todo.links.length, 1)
  assert.equal(todo.links[0].kind, 'url')
  assert.equal(todo.activity.length, 1)
  assert.equal(todo.activity[0].kind, 'created')
  assert.equal(todo.activity[0].by, 'agent')
})

test('a title is mandatory and bounded', () => {
  assert.throws(() => createTodo({}, { now: NOW }), /标题不能为空/)
  assert.throws(() => createTodo({ title: 'x'.repeat(LIMITS.title + 1) }, { now: NOW }), /最多 200/)
})

test('ids are prefixed, unique and collision safe', () => {
  const first = newId()
  assert.match(first, /^t-[0-9a-f]{8}$/)
  assert.notEqual(first, newId([first]))
})

test('due dates accept ISO-8601 shapes and reject nonsense', () => {
  assert.equal(normalizeDue(''), null)
  assert.equal(normalizeDue(null), null)
  assert.equal(normalizeDue('2026-10-20'), '2026-10-20T00:00:00.000Z')
  assert.equal(normalizeDue('2026-10-20T10:00:00+08:00'), '2026-10-20T02:00:00.000Z')
  assert.throws(() => normalizeDue('tomorrow'), /无法解析/)
  assert.throws(() => normalizeDue(1750000000000), /必须是 ISO-8601/)
})

test('tags are de-duplicated case-insensitively and bounded', () => {
  assert.deepEqual(normalizeTags('#工作, 工作 , 生活'), ['工作', '生活'])
  assert.deepEqual(normalizeTags(''), [])
  assert.deepEqual(normalizeTags(['a', 'b']), ['a', 'b'])
  assert.throws(() => normalizeTags(['x'.repeat(LIMITS.tag + 1)]), /最多 32/)
  assert.throws(() => normalizeTags(Array.from({ length: LIMITS.tags + 1 }, (_, index) => `t${index}`)), /最多 20/)
})

test('patch reports exactly what changed and keeps createdAt immutable', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  const changed = applyPatch(todo, { title: 'B', priority: 'high', due: '2026-11-01' }, { now: NOW + 1000, by: 'human' })
  assert.deepEqual(changed, ['title', 'priority', 'dueAt'])
  assert.equal(todo.title, 'B')
  assert.equal(todo.priority, 'high')
  assert.equal(todo.dueAt, '2026-11-01T00:00:00.000Z')
  assert.equal(todo.createdAt, NOW)
  assert.equal(todo.updatedAt, NOW + 1000)
  assert.deepEqual(applyPatch(todo, { priority: 'high' }, { now: NOW + 2000 }), [])
})

test('a patch that changes nothing does not touch the record', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  const changed = applyPatch(todo, { title: 'A' }, { now: NOW + 5000 })
  assert.deepEqual(changed, [])
  assert.equal(todo.updatedAt, NOW)
})

test('clearing fields works through empty values', () => {
  const todo = createTodo({ title: 'A', due: '2026-11-01', tags: ['x'] }, { now: NOW })
  applyPatch(todo, { dueAt: '', tags: [] }, { now: NOW + 1 })
  assert.equal(todo.dueAt, null)
  assert.deepEqual(todo.tags, [])
})

test('status transitions stamp and clear the completion time', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  assert.equal(setStatus(todo, 'done', { now: NOW + 10, by: 'agent' }), true)
  assert.equal(todo.status, 'done')
  assert.equal(todo.doneAt, NOW + 10)
  assert.equal(todo.activity.at(-1).kind, 'done')
  assert.equal(setStatus(todo, 'open', { now: NOW + 20 }), true)
  assert.equal(todo.doneAt, null)
  assert.equal(todo.activity.at(-1).kind, 'reopened')
  assert.equal(setStatus(todo, 'open', { now: NOW + 30 }), false)
  assert.throws(() => setStatus(todo, 'later', { now: NOW }), /状态只能是/)
})

test('attachments de-duplicate and can be removed by key or index', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  assert.equal(addLink(todo, 'https://example.com/a', { now: NOW }).added, true)
  assert.equal(addLink(todo, 'https://example.com/a', { now: NOW }).added, false)
  assert.equal(todo.links.length, 1)
  const removed = removeLink(todo, { key: todo.links[0] && `${todo.links[0].kind}\u0000${todo.links[0].value}` }, { now: NOW })
  assert.equal(removed.value, 'https://example.com/a')
  assert.equal(todo.links.length, 0)
  addLink(todo, '/tmp/a.md', { now: NOW })
  assert.equal(removeLink(todo, { index: 0 }, { now: NOW }).value, '/tmp/a.md')
  assert.equal(removeLink(todo, { index: 5 }, { now: NOW }), null)
})

test('the activity trail is trimmed to the configured limit', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  for (let index = 0; index < 60; index += 1) pushActivity(todo, { kind: 'updated', at: NOW + index }, 5)
  assert.equal(todo.activity.length, 5)
  assert.equal(todo.activity.at(-1).at, NOW + 59)
})

test('dispatch history records both the success and the failure', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  recordDispatch(todo, { mode: 'new', ok: true, sessionId: 'session-1' }, { now: NOW + 1 })
  assert.equal(todo.sessionId, 'session-1')
  assert.equal(todo.lastDispatch.ok, true)
  recordDispatch(todo, { mode: 'auto', ok: false, error: '没有 agent' }, { now: NOW + 2 })
  assert.equal(todo.lastDispatch.ok, false)
  assert.equal(todo.lastDispatch.error, '没有 agent')
  assert.equal(todo.sessionId, 'session-1', 'a failed hand-off must not clear the binding')
  assert.equal(todo.activity.at(-1).kind, 'dispatch-failed')
})

test('overdue only counts live, dated todos', () => {
  const base = createTodo({ title: 'A', due: '2026-10-01' }, { now: NOW })
  assert.equal(isOverdue(base, NOW), true)
  setStatus(base, 'done', { now: NOW })
  assert.equal(isOverdue(base, NOW), false)
  assert.equal(isOverdue(createTodo({ title: 'B' }, { now: NOW }), NOW), false)
})

test('counts summarise a list', () => {
  const todos = [
    createTodo({ title: 'A', due: '2026-10-01' }, { now: NOW }),
    createTodo({ title: 'B' }, { now: NOW }),
  ]
  setStatus(todos[1], 'done', { now: NOW })
  const summary = counts(todos, NOW)
  assert.deepEqual(summary, { total: 2, open: 1, doing: 0, done: 1, cancelled: 0, archived: 0, overdue: 1 })
})

test('loading tolerates damage: bad rows and bad attachments are dropped, the rest survives', () => {
  const stored = normalizeStored(
    {
      id: 't-1',
      title: '活的',
      createdAt: 1,
      status: 'nonsense',
      priority: 'someday',
      dueAt: 'not a date',
      tags: ['ok', 5],
      links: ['https://example.com/ok', '', 'relative/path.md'],
      activity: [{ kind: 'created', at: 1 }, 'junk', { nope: true }],
    },
    { activityLimit: 10 },
  )
  assert.equal(stored.status, 'open')
  assert.equal(stored.priority, 'normal')
  assert.equal(stored.dueAt, null)
  assert.deepEqual(stored.tags, ['ok'])
  assert.equal(stored.links.length, 1)
  assert.equal(stored.activity.length, 1)
})

test('the origin of a todo survives a round trip through the file', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW, origin: { dir: '/home/me/x', sessionId: 'session-1' } })
  assert.equal(todo.originDir, '/home/me/x')
  assert.equal(todo.originSessionId, 'session-1')
  const reloaded = normalizeStored(JSON.parse(JSON.stringify(todo)), { activityLimit: 10 })
  assert.equal(reloaded.originDir, '/home/me/x')
  assert.equal(reloaded.originSessionId, 'session-1')
  // A record written before this field existed must still load.
  const legacy = normalizeStored({ id: 't-old', title: '旧记录' }, { activityLimit: 10 })
  assert.equal(legacy.originDir, '')
})

test('levels run from P0 to P3 and the older values still load', () => {
  assert.deepEqual([...PRIORITIES], ['urgent', 'high', 'normal', 'low'])
  const urgent = createTodo({ title: 'A', priority: 'urgent' }, { now: NOW })
  assert.equal(urgent.priority, 'urgent')
  applyPatch(urgent, { priority: 'high' }, { now: NOW })
  assert.equal(urgent.priority, 'high')
  // A record written before `urgent` existed must still load unchanged.
  for (const legacy of ['high', 'normal', 'low']) {
    assert.equal(normalizeStored({ id: 't-1', title: 'A', priority: legacy }, { activityLimit: 5 }).priority, legacy)
  }
  assert.equal(normalizeStored({ id: 't-1', title: 'A', priority: 'nonsense' }, { activityLimit: 5 }).priority, 'normal')
  assert.equal(PRIORITY_LABELS.urgent, 'P0 紧急')
})

test('notes append, are capped, and survive a round trip', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  assert.deepEqual(todo.notes, [])
  addNote(todo, '第一步做完了', { now: NOW, by: 'agent' })
  addNote(todo, '卡在需要授权', { now: NOW + 1, by: 'agent' })
  assert.equal(todo.notes.length, 2)
  assert.equal(todo.notes[1].text, '卡在需要授权')
  assert.equal(todo.notes[1].by, 'agent')
  assert.equal(todo.updatedAt, NOW + 1)
  assert.equal(todo.activity.at(-1).kind, 'noted')

  // A record written before notes existed still loads, and junk is dropped.
  const legacy = normalizeStored({ id: 't-1', title: '旧' }, { activityLimit: 10 })
  assert.deepEqual(legacy.notes, [])
  const repaired = normalizeStored(
    { id: 't-2', title: 'A', notes: [{ at: 1, by: 'agent', text: 'ok' }, { text: '' }, 'junk', null] },
    { activityLimit: 10 },
  )
  assert.equal(repaired.notes.length, 1)

  // The cap keeps one todo from becoming a log file.
  for (let index = 0; index < LIMITS.notes + 5; index += 1) addNote(todo, `第 ${index} 条`, { now: NOW + index })
  assert.equal(todo.notes.length, LIMITS.notes)
  assert.match(todo.notes.at(-1).text, /第 \d+ 条/)
})

test('completing a todo keeps the evidence and reopening drops it', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  completeTodo(
    todo,
    { summary: '做了 X，结果是 Y', artifacts: [{ kind: 'file', value: '/home/me/x/a.md', title: 'a.md' }], sessionId: 'session-1' },
    { now: NOW, by: 'agent' },
  )
  assert.equal(todo.status, 'done')
  assert.equal(todo.doneAt, NOW)
  assert.equal(todo.completion.by, 'agent')
  assert.equal(todo.completion.summary, '做了 X，结果是 Y')
  assert.equal(todo.completion.sessionId, 'session-1')
  assert.equal(todo.completion.artifacts.length, 1)
  assert.equal(todo.activity.at(-1).kind, 'completed')

  // Reopening must not leave a completion record describing a finished job.
  setStatus(todo, 'open', { now: NOW + 1 })
  assert.equal(todo.completion, null)
  assert.equal(todo.doneAt, null)
})

test('an artifact that no longer exists still records the completion', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  // requireExistingFiles is on, and this path does not exist: artifacts are
  // claims, so the completion must survive.
  completeTodo(
    todo,
    { summary: 'ok', artifacts: [{ kind: 'file', value: '/definitely/missing.md' }] },
    { now: NOW, exists: () => false, requireExistingFiles: true },
  )
  assert.equal(todo.status, 'done')
  assert.equal(todo.completion.artifacts.length, 1)
})

test('a stored completion survives a round trip and a legacy record still loads', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  completeTodo(todo, { summary: 's', artifacts: [{ kind: 'url', value: 'https://example.com/x' }] })
  const reloaded = normalizeStored(JSON.parse(JSON.stringify(todo)), { activityLimit: 10 })
  assert.equal(reloaded.completion.summary, 's')
  assert.equal(reloaded.completion.artifacts[0].value, 'https://example.com/x')
  const legacy = normalizeStored({ id: 't-1', title: '旧', status: 'done' }, { activityLimit: 10 })
  assert.equal(legacy.completion, null)
})

test('loading refuses records without an id or a title', () => {
  assert.equal(normalizeStored({ title: 'no id' }), null)
  assert.equal(normalizeStored({ id: 't-1' }), null)
  assert.equal(normalizeStored('nope'), null)
  assert.equal(normalizeStored(null), null)
})

test('stored documents keep a since-deleted attachment visible', () => {
  const stored = normalizeStored(
    { id: 't-1', title: 'A', links: [{ kind: 'file', value: '/gone/away.md', title: '旧文档' }] },
    { activityLimit: 5 },
  )
  assert.equal(stored.links.length, 1)
  assert.equal(stored.links[0].value, '/gone/away.md')
})

test('invalid input types are rejected with a code', () => {
  try {
    createTodo({ title: 5 }, { now: NOW })
    assert.fail('should have thrown')
  } catch (error) {
    assert.ok(error instanceof TodoError)
    assert.equal(error.code, 'invalid-title')
  }
})
