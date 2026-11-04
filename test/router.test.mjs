import { strict as assert } from 'node:assert'
import test from 'node:test'

import { dayKey } from '../lib/gate.js'
import { buildSnapshot, hasRecentMark, markedDay, planTick, runTick, TRIAGE_MARK, WATCHDOG_MARK } from '../lib/router.js'

const NOW = Date.parse('2026-11-03T10:00:00+08:00')
const DAY = 86_400_000
const HOUR = 3_600_000

/** @param {object} [overrides] */
function todo(overrides = {}) {
  return {
    id: 't-00000001',
    seq: 1,
    title: '等你定一下发布顺序',
    description: '',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    tags: [],
    steps: [],
    links: [],
    notes: [],
    activity: [],
    originDir: '/srv/demo',
    lastDispatch: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...overrides,
  }
}

const policy = { dailyCap: 2, cooldownDays: 3 }

test('a mark carries the day it was written for', () => {
  assert.equal(markedDay(`${TRIAGE_MARK} 2026-11-03】今日第 1/3 条`), '2026-11-03')
  assert.equal(markedDay('普通进展'), '')
})

test('a note stops a second announcement for a week, then lets it through again', () => {
  const fresh = todo({ notes: [{ at: NOW - DAY, by: 'agent', text: `${TRIAGE_MARK} 2026-11-02】今日第 1/3 条` }] })
  assert.equal(hasRecentMark(fresh, TRIAGE_MARK, NOW), true)
  const stale = todo({ notes: [{ at: NOW - 8 * DAY, by: 'agent', text: `${TRIAGE_MARK} 2026-10-26】今日第 1/3 条` }] })
  assert.equal(hasRecentMark(stale, TRIAGE_MARK, NOW), false)
})

test('the tick announces today three and nothing else', () => {
  const plan = planTick([
    todo({ id: 't-1', seq: 1, priority: 'urgent' }),
    todo({ id: 't-2', seq: 2, priority: 'high' }),
    todo({ id: 't-3', seq: 3 }),
    todo({ id: 't-4', seq: 4 }),
  ], { now: NOW, policy })
  assert.deepEqual(plan.snapshot.triage.today.map((row) => row.id), ['t-1', 't-2', 't-3'])
  assert.deepEqual(plan.notes.map((note) => note.id), ['t-1', 't-2', 't-3'])
  // The day in the mark is the local day of `now`, not a +08 calendar date: the suite runs
  // under whatever TZ the machine has (CI is UTC).
  assert.match(plan.notes[0].text, new RegExp(`^【分诊 ${dayKey(NOW)}】今日第 1/3 条 · 该你一句话`))
})

test('a second tick on the same day writes nothing: the record is the ledger', () => {
  const todos = [todo({ id: 't-1', priority: 'urgent' })]
  const first = planTick(todos, { now: NOW, policy })
  assert.equal(first.notes.length, 1)
  // Fold the note back in, exactly as the store would after the write.
  const after = [{ ...todos[0], notes: [{ at: NOW, by: 'agent', text: first.notes[0].text }] }]
  assert.deepEqual(planTick(after, { now: NOW + 60_000, policy }).notes, [])
})

test('a stalled hand-off is announced once, not once a day', () => {
  const dispatched = todo({
    id: 't-1',
    lastDispatch: { at: NOW - 30 * HOUR, ok: true, mode: 'new', sessionId: 's-1' },
    activity: [{ kind: 'dispatched', by: 'human', at: NOW - 30 * HOUR, summary: 'new → s-1' }],
  })
  const first = planTick([dispatched], { now: NOW, policy })
  const watchdog = first.notes.filter((note) => note.kind === 'watchdog')
  assert.equal(watchdog.length, 1)
  assert.match(watchdog[0].text, new RegExp(`^【看门狗 ${dayKey(NOW)}】派发后 30 小时没有新进展`))

  const again = [{ ...dispatched, notes: [{ at: NOW, by: 'agent', text: watchdog[0].text }] }]
  assert.equal(planTick(again, { now: NOW + DAY, policy }).notes.filter((note) => note.kind === 'watchdog').length, 0)
})

test('observe mode proposes only as many hand-offs as the budget allows', () => {
  const todos = [
    todo({ id: 't-1', tags: ['可自动'], originDir: '/srv/a' }),
    todo({ id: 't-2', tags: ['可自动'], originDir: '/srv/b' }),
    todo({ id: 't-3', tags: ['可自动'], originDir: '/srv/c' }),
  ]
  const plan = planTick(todos, { now: NOW, policy: { dailyCap: 2, cooldownDays: 3 } })
  assert.equal(plan.snapshot.gate.allowed.length, 3)
  assert.equal(plan.wouldDispatch.length, 2)
})

test('the snapshot is read-only and answers the same question every time', () => {
  const todos = [todo({ id: 't-1' })]
  const snapshot = buildSnapshot(todos, { now: NOW, policy })
  assert.equal(snapshot.triage.counts.active, 1)
  assert.equal(snapshot.gate.budget.used, 0)
  assert.deepEqual(todos[0].notes, [])
})

test('runTick stays silent when the mode is off', async () => {
  const written = []
  const result = await runTick({
    service: { listAll: async () => [todo({ id: 't-1', priority: 'urgent' })], note: async (id, text) => written.push({ id, text }) },
    settings: { get: () => ({ routerMode: 'off' }) },
    now: NOW,
  })
  assert.equal(result.skipped, true)
  assert.deepEqual(written, [])
})

test('runTick writes the notes it planned, and only notes', async () => {
  const written = []
  const changes = []
  const result = await runTick({
    service: {
      listAll: async () => [todo({ id: 't-1', priority: 'urgent' })],
      note: async (id, text, context) => {
        written.push({ id, text, context })
        return { todo: {}, note: { text } }
      },
      setStatus: async (...args) => changes.push(args),
      recordDispatch: async (...args) => changes.push(args),
    },
    settings: { get: () => ({ routerMode: 'observe', routerDailyCap: 2, routerCooldownDays: 3 }) },
    sessionAlive: () => false,
    now: NOW,
  })
  assert.equal(result.mode, 'observe')
  assert.equal(result.skipped, false)
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].context, { by: 'agent' })
  assert.deepEqual(result.notes, [{ id: 't-1', kind: 'triage' }])
  // Observe means observe: no status changed and nothing was handed over.
  assert.deepEqual(changes, [])
})

test('one unreadable record does not cost the others their note', async () => {
  const written = []
  const result = await runTick({
    service: {
      listAll: async () => [
        todo({ id: 't-1', seq: 1, priority: 'urgent' }),
        todo({ id: 't-2', seq: 2, priority: 'high' }),
      ],
      note: async (id, text) => {
        if (id === 't-1') throw new Error('磁盘满了')
        written.push({ id, text })
      },
    },
    settings: { get: () => ({ routerMode: 'observe' }) },
    now: NOW,
  })
  assert.deepEqual(written.map((entry) => entry.id), ['t-2'])
  assert.deepEqual(result.notes.map((note) => note.id), ['t-2'])
})

test('a tick whose notes all failed reports the failures instead of looking done', async () => {
  const result = await runTick({
    service: {
      listAll: async () => [todo({ id: 't-1', priority: 'urgent' })],
      note: async () => {
        throw new Error('store-busy')
      },
    },
    settings: { get: () => ({ routerMode: 'observe' }) },
    now: NOW,
  })
  assert.deepEqual(result.notes, [])
  assert.equal(result.failed, 1, 'the caller has to know the day did not actually run')
})
