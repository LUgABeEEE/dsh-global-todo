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
  isValidDue,
  parseDueText,
  newId,
  normalizeDue,
  normalizeStored,
  normalizeTags,
  pushActivity,
  recordDispatch,
  removeLink,
  reviewTodo,
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
  // No deadline, so the level is 低 — the model no longer picks it (0.22.0 rule).
  assert.equal(todo.priority, 'low')
  assert.equal(todo.prioritySource, 'rule')
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
  // A date-only deadline is local midnight (issue #6), so the ISO value depends on the zone.
  assert.equal(normalizeDue('2026-10-20'), new Date(2026, 9, 20).toISOString())
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
  assert.equal(todo.dueAt, new Date(2026, 10, 1).toISOString(), 'date-only means local midnight')
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
  assert.deepEqual(summary, { total: 2, open: 1, doing: 0, done: 1, cancelled: 0, archived: 0, overdue: 1, inbox: 0, review: 0 })
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
  // An agent asking for 紧急 without a deadline is a suggestion: the level stays 低 and the
  // request is kept where a person can see it.
  const urgent = createTodo({ title: 'A', priority: 'urgent' }, { now: NOW })
  assert.equal(urgent.priority, 'low')
  assert.equal(urgent.suggestedPriority, 'urgent')
  // With a deadline 20 hours out the rule answers 高, whatever the agent asked for.
  const soon = createTodo(
    { title: 'B', priority: 'low', dueAt: new Date(NOW + 20 * 3600 * 1000).toISOString() },
    { now: NOW },
  )
  assert.equal(soon.priority, 'high')
  assert.equal(soon.suggestedPriority, 'low')
  // A record written before `urgent` existed must still load unchanged.
  for (const legacy of ['high', 'normal', 'low']) {
    assert.equal(normalizeStored({ id: 't-1', title: 'A', priority: legacy }, { activityLimit: 5 }).priority, legacy)
  }
  assert.equal(normalizeStored({ id: 't-1', title: 'A', priority: 'nonsense' }, { activityLimit: 5 }).priority, 'normal')
  assert.equal(PRIORITY_LABELS.urgent, 'P0 紧急')
})

test('a person\'s level is locked only when they actually change it', () => {
  // The panel sends the whole draft on every save, so "edited the title" arrives with the level
  // attached. Locking on presence would pin the level of every record somebody touched, and a
  // level nobody asked for should keep following the deadline.
  const todo = createTodo({ title: 'A', dueAt: new Date(NOW + 30 * 24 * 3600 * 1000).toISOString() }, { now: NOW })
  assert.equal(todo.priority, 'low')
  assert.equal(todo.prioritySource, 'rule')
  const changed = applyPatch(todo, { title: 'A 改过', priority: 'low' }, { now: NOW + 1000, by: 'human' })
  assert.deepEqual(changed, ['title'])
  assert.equal(todo.prioritySource, 'rule', 'a save that did not touch the level must not lock it')

  // Picking a different level is the decision, and it sticks.
  const locked = applyPatch(todo, { priority: 'urgent' }, { now: NOW + 2000, by: 'human' })
  assert.deepEqual(locked, ['priority'])
  assert.equal(todo.priority, 'urgent')
  assert.equal(todo.prioritySource, 'human')
  // From then on neither a deadline change nor an agent suggestion moves it.
  applyPatch(todo, { dueAt: new Date(NOW + 60 * 24 * 3600 * 1000).toISOString() }, { now: NOW + 3000, by: 'agent' })
  assert.equal(todo.priority, 'urgent')
  applyPatch(todo, { priority: 'low' }, { now: NOW + 4000, by: 'agent' })
  assert.equal(todo.priority, 'urgent', 'an agent level is only a suggestion')
  assert.equal(todo.suggestedPriority, 'low')
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

test('an agent finishing something asks for review; a person finishing it does not', () => {
  const byAgent = createTodo({ title: '交给 Agent 的' }, { now: NOW })
  setStatus(byAgent, 'done', { now: NOW, by: 'agent' })
  assert.equal(byAgent.review?.pending, true, 'an agent completion is a claim, not a decision')
  assert.equal(counts([byAgent], NOW).review, 1)

  const byHuman = createTodo({ title: '自己勾掉的' }, { now: NOW })
  setStatus(byHuman, 'done', { now: NOW, by: 'human' })
  assert.equal(byHuman.review, null, 'a person marking it done needs no confirmation')

  // The completion path the agent tools use carries the same rule.
  const completed = createTodo({ title: '带完成说明的' }, { now: NOW })
  completeTodo(completed, { summary: '做完了' }, { now: NOW, by: 'agent' })
  assert.equal(completed.review?.pending, true)
})

test('reviewing answers the claim and leaves nothing half-decided', () => {
  const confirmed = createTodo({ title: 'A' }, { now: NOW })
  completeTodo(confirmed, { summary: '做完了' }, { now: NOW, by: 'agent' })
  assert.equal(reviewTodo(confirmed, 'confirm', { now: NOW }), true)
  assert.equal(confirmed.status, 'done', 'confirming keeps it finished')
  assert.equal(confirmed.review, null)
  assert.notEqual(confirmed.completion, null, 'the completion record survives the confirmation')

  const rejected = createTodo({ title: 'B' }, { now: NOW })
  setStatus(rejected, 'done', { now: NOW, by: 'agent' })
  assert.equal(reviewTodo(rejected, 'reject', { now: NOW }), true)
  assert.equal(rejected.status, 'open', 'a rejected claim goes back on the list')
  assert.equal(rejected.review, null)
  assert.equal(rejected.completion, null, 'a record claiming the work is done must not survive a rejection')

  // Nothing to answer twice, and reopening a settled record drops the mark.
  assert.equal(reviewTodo(rejected, 'confirm', { now: NOW }), false)
  const reopened = createTodo({ title: 'C' }, { now: NOW })
  setStatus(reopened, 'done', { now: NOW, by: 'agent' })
  setStatus(reopened, 'open', { now: NOW, by: 'human' })
  assert.equal(reopened.review, null)
})

test('steps are a plan: strings become steps, ticks survive a load', () => {
  const todo = createTodo(
    { title: '发版', steps: ['跑 verify', { text: '打 tag', done: true }] },
    { now: NOW },
  )
  assert.deepEqual(todo.steps, [
    { text: '跑 verify', done: false },
    { text: '打 tag', done: true },
  ])
  // A blank step is refused rather than dropped: it used to disappear while the caller
  // believed it was stored, and it earned the capture weight bonus on the way.
  assert.throws(
    () => createTodo({ title: '空步骤', steps: ['  '] }, { now: NOW }),
    (error) => error instanceof TodoError && error.code === 'invalid-steps',
  )

  const reloaded = normalizeStored(JSON.parse(JSON.stringify(todo)))
  assert.deepEqual(reloaded.steps, todo.steps, 'a tick has to survive the file')
})

test('steps can be replaced through a patch, and are capped', () => {
  const todo = createTodo({ title: 'A' }, { now: NOW })
  applyPatch(todo, { steps: ['一', '二'] }, { now: NOW })
  assert.deepEqual(todo.steps.map((step) => step.text), ['一', '二'])
  applyPatch(todo, { steps: [{ text: '一', done: true }] }, { now: NOW })
  assert.deepEqual(todo.steps, [{ text: '一', done: true }])

  // A plan longer than the cap is refused rather than silently truncated: twenty steps in
  // one todo means the todo should have been split.
  assert.throws(
    () => createTodo({ title: 'B', steps: new Array(LIMITS.steps + 1).fill('x') }, { now: NOW }),
    (error) => error instanceof TodoError && error.code === 'invalid-steps',
  )
})

test('an item can carry the sentence it came from', () => {
  const todo = createTodo({ title: '补给 NAS 加权限', evidence: '  「NAS 那个目录记得加上权限」  ' }, { now: NOW })
  assert.equal(todo.evidence, '「NAS 那个目录记得加上权限」', 'trimmed, kept verbatim')

  // A self-recorded item has no quote, and that is not an error.
  assert.equal(createTodo({ title: '自己记的' }, { now: NOW }).evidence, '')

  // Too long is refused rather than silently cut: an evidence that is not the sentence
  // is not evidence.
  assert.throws(
    () => createTodo({ title: 'A', evidence: 'x'.repeat(LIMITS.evidence + 1) }, { now: NOW }),
    (error) => error instanceof TodoError && error.code === 'invalid-evidence',
  )

  const reloaded = normalizeStored(JSON.parse(JSON.stringify(todo)))
  assert.equal(reloaded.evidence, todo.evidence, 'and it survives the file')
})

test('the P0–P3 labels the panel prints are accepted on the way in', () => {
  // Accepted and understood — as the agent's suggestion, because the level itself comes from the
  // deadline. A person's own form is the one that sets the level directly.
  assert.equal(createTodo({ title: 'a', priority: 'P0' }).suggestedPriority, 'urgent')
  assert.equal(createTodo({ title: 'b', priority: ' p3 ' }).suggestedPriority, 'low')
  assert.equal(createTodo({ title: 'a2', priority: 'P0' }, { by: 'human', prioritySource: 'human' }).priority, 'urgent')
  const todo = createTodo({ title: 'c' })
  applyPatch(todo, { priority: 'P1' }, { by: 'human' })
  assert.equal(todo.priority, 'high')
  assert.throws(() => createTodo({ title: 'd', priority: 'P9' }), (error) => error instanceof TodoError && error.code === 'invalid-priority')
})

test('an over-long step is refused, like an over-long list', () => {
  const tooLong = 'x'.repeat(LIMITS.step + 1)
  assert.throws(() => createTodo({ title: 'steps', steps: [tooLong] }), (error) => error instanceof TodoError && error.code === 'invalid-steps')
  assert.throws(
    () => createTodo({ title: 'steps', steps: [{ text: tooLong }] }),
    (error) => error instanceof TodoError && error.code === 'invalid-steps',
  )
  const atLimit = createTodo({ title: 'steps', steps: ['x'.repeat(LIMITS.step)] })
  assert.equal(atLimit.steps[0].text.length, LIMITS.step)
})

test('a deadline is either a date or a date with time, and nothing invented', () => {
  // The old parser was a bare Date.parse: "2026" became January 1st, "October 2026" a
  // timezone-dependent day. A deadline silently invented is worse than a rejected one.
  for (const value of ['2026', '2026-10', 'October 2026', '2026-02-31', '30', 'tomorrow', '2026-13-01', '2026-10-20T24:00']) {
    assert.throws(
      () => createTodo({ title: 'due', dueAt: value }, { now: NOW }),
      (error) => error instanceof TodoError && error.code === 'invalid-due',
      value,
    )
    assert.equal(isValidDue(value), false, value)
  }
  for (const value of ['2026-10-20', '2026-10-20T10:00', '2026-10-20 10:00', '2026-10-20T10:00:30Z', '2026-10-20T10:00+08:00']) {
    assert.equal(isValidDue(value), true, value)
    assert.match(createTodo({ title: 'due', dueAt: value }, { now: NOW }).dueAt, /^\d{4}-\d{2}-\d{2}T/)
  }
})

test('a date-only deadline is local midnight, not UTC midnight', () => {
  // Issue #6: Date.parse('2026-11-01') is UTC midnight per the specification, so on +08 the
  // bound covered the first eight hours of the bound day. Compare against the local
  // constructor, which is what a person means by "that day".
  const iso = parseDueText('2026-11-01').iso
  assert.equal(iso, new Date(2026, 10, 1, 0, 0, 0, 0).toISOString())
  assert.equal(normalizeDue('2026-11-01'), new Date(2026, 10, 1).toISOString())
  // A date with a time keeps its own meaning.
  assert.equal(parseDueText('2026-11-01T10:00').iso, new Date(2026, 10, 1, 10, 0).toISOString())
  assert.equal(parseDueText('2026-11-01T10:00:00Z').iso, '2026-11-01T10:00:00.000Z')
})
