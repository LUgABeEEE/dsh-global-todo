import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  BUCKETS,
  CLASSIFY_TAGS,
  TOP_COUNT,
  buildTriage,
  classify,
  isSnoozed,
  lastChase,
  localDay,
  scoreTodo,
  snoozeOf,
} from '../lib/triage.js'

const NOW = Date.parse('2026-11-03T01:00:00+08:00')

/** The same local time, `days` later: the suite may run in any timezone (CI is UTC). */
const plusLocalDays = (days) => {
  const date = new Date(NOW)
  date.setDate(date.getDate() + days)
  return date.getTime()
}
const DAY = 86_400_000

/** @param {object} [overrides] a record shaped like the store's, with nothing incidental set */
function todo(overrides = {}) {
  return {
    id: 't-00000001',
    seq: 1,
    title: '把某件事做完',
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

test('a tag states the intent, and the text cannot override it', () => {
  // 「可自动」 next to a description that happens to say 「确认」 is still an agent's job: the
  // tag is what the person typed deliberately.
  const verdict = classify(todo({ tags: ['可自动'], description: '确认一下日志' }))
  assert.equal(verdict.bucket, 'self')
  assert.equal(verdict.by, 'tag')
})

test('a decision outranks waiting, and waiting outranks maintenance', () => {
  assert.equal(classify(todo({ title: '等你定方案' })).bucket, 'decision')
  assert.equal(classify(todo({ title: '等对方回复邮件' })).bucket, 'external')
  assert.equal(classify(todo({ title: '整理一下备份' })).bucket, 'self')
  assert.equal(classify(todo({ title: '把书看完' })).bucket, 'unknown')
})

test('the buckets stay the documented four', () => {
  assert.deepEqual([...BUCKETS], ['decision', 'self', 'external', 'unknown'])
  assert.equal(CLASSIFY_TAGS.auto, '可自动')
  assert.equal(TOP_COUNT, 3)
})

test('an overdue deadline is loud, named, and grows to a cap', () => {
  const yesterday = scoreTodo(todo({ dueAt: new Date(NOW - DAY).toISOString() }), NOW)
  assert.ok(yesterday.score > 3)
  assert.match(yesterday.why[0], /^逾期 1 天$/)

  const ancient = scoreTodo(todo({ dueAt: new Date(NOW - 60 * DAY).toISOString() }), NOW)
  // 14 days is where the growth stops: an arbitrarily old mistake is not more urgent than a
  // two-week-old one, it is just older.
  assert.equal(ancient.score, 5.8)
})

test('a deadline later today is not "0 days out"', () => {
  const soon = scoreTodo(todo({ dueAt: new Date(NOW + 3_600_000).toISOString() }), NOW)
  assert.deepEqual(soon.why, ['今天到期'])
})

test('a hand-off two days ago is quieter than one that never happened', () => {
  const fresh = scoreTodo(todo({ lastDispatch: { at: NOW - DAY, ok: true } }), NOW)
  assert.equal(fresh.score, -2)
  assert.match(fresh.why[0], /刚派过/)
  assert.equal(scoreTodo(todo(), NOW).score, 0)
})

test('the inbox is counted, never triaged', () => {
  const report = buildTriage([
    todo({ id: 't-1', tags: ['inbox'], title: '等你确认这条' }),
    todo({ id: 't-2', title: '等你定方案' }),
  ], { now: NOW })
  assert.equal(report.counts.inbox, 1)
  assert.equal(report.counts.active, 1)
  assert.deepEqual(report.rows.map((row) => row.id), ['t-2'])
  assert.equal(report.buckets.decision, 1)
})

test('review and overdue are counted from the records, not the buckets', () => {
  const report = buildTriage([
    todo({ id: 't-1', status: 'done', review: { pending: true, at: NOW } }),
    todo({ id: 't-2', dueAt: new Date(NOW - 2 * DAY).toISOString() }),
  ], { now: NOW })
  assert.equal(report.counts.review, 1)
  assert.equal(report.counts.overdue, 1)
  assert.equal(report.rows.length, 1)
})

test('today is the top three, ordered by score then by the record own order', () => {
  const report = buildTriage([
    todo({ id: 't-1', seq: 1, priority: 'low' }),
    todo({ id: 't-2', seq: 2, priority: 'urgent' }),
    todo({ id: 't-3', seq: 3, dueAt: new Date(NOW - DAY).toISOString() }),
    todo({ id: 't-4', seq: 4 }),
  ], { now: NOW })
  // Overdue one day (3.2) beats urgent (3), which beats a plain record (0); the low one (-1)
  // does not make the three.
  assert.deepEqual(report.today.map((row) => row.id), ['t-3', 't-2', 't-4'])
  assert.equal(report.today.length, TOP_COUNT)
})

test('ties fall back to seq, so the same list always yields the same three', () => {
  const first = buildTriage([todo({ id: 't-9', seq: 9 }), todo({ id: 't-2', seq: 2 })], { now: NOW })
  const second = buildTriage([todo({ id: 't-2', seq: 2 }), todo({ id: 't-9', seq: 9 })], { now: NOW })
  assert.deepEqual(first.today.map((row) => row.id), second.today.map((row) => row.id))
})

test('an empty or malformed list is an empty report, not a crash', () => {
  const report = buildTriage([null, undefined, {}], { now: NOW })
  assert.equal(report.counts.active, 0)
  assert.deepEqual(report.rows, [])
  assert.deepEqual(report.today, [])
})

test('a deferral note keeps a record out of today, and the newest mark wins', () => {
  const snoozed = todo({ notes: [{ at: NOW - 1000, by: 'human', text: '【推迟 2026-11-05】推迟 2 天，先不看' }] })
  assert.deepEqual(snoozeOf(snoozed), { until: '2026-11-05', at: NOW - 1000 })
  assert.equal(isSnoozed(snoozed, NOW), true)
  // Past the day it names, the deferral is over without anyone clearing it.
  assert.equal(isSnoozed(snoozed, plusLocalDays(4)), false)

  const extended = todo({
    notes: [
      { at: NOW - 2000, by: 'human', text: '【推迟 2026-11-04】推迟 1 天' },
      { at: NOW - 1000, by: 'human', text: '【推迟 2026-11-10】推迟 7 天' },
    ],
  })
  assert.equal(snoozeOf(extended).until, '2026-11-10')
})

test('a snoozed record is counted but not triaged', () => {
  const report = buildTriage([
    todo({ id: 't-1', title: '等你定方案', notes: [{ at: NOW - 1000, by: 'human', text: '【推迟 2026-11-09】推迟 6 天' }] }),
    todo({ id: 't-2', title: '等你定发布顺序' }),
  ], { now: NOW })
  assert.equal(report.counts.active, 2)
  assert.equal(report.counts.snoozed, 1)
  assert.deepEqual(report.rows.map((row) => row.id), ['t-2'])
  assert.equal(report.buckets.decision, 1)
})

test('a chase note says when the other side was last asked', () => {
  const chased = todo({
    title: '等对方回复邮件',
    notes: [
      { at: NOW - 9 * DAY, by: 'human', text: '【催办 2026-10-25】催了一次' },
      { at: NOW - 2 * DAY, by: 'human', text: '【催办 2026-11-01】催了一次' },
    ],
  })
  assert.deepEqual(lastChase(chased, NOW), { at: NOW - 2 * DAY, day: '2026-11-01', days: 2 })
  assert.equal(lastChase(todo(), NOW), null)

  const report = buildTriage([chased], { now: NOW })
  assert.equal(report.rows[0].bucket, 'external')
  assert.equal(report.rows[0].chaseDays, 2)
})

test('only the external bucket carries a chase age', () => {
  const report = buildTriage([
    todo({ id: 't-1', title: '等你定方案', notes: [{ at: NOW - DAY, by: 'human', text: '【催办 2026-11-02】' }] }),
  ], { now: NOW })
  assert.equal(report.rows[0].bucket, 'decision')
  assert.equal(report.rows[0].chaseDays, null)
})

test('one day of snooze means tomorrow, not the day after', () => {
  const today = localDay(NOW)
  const tomorrow = localDay(plusLocalDays(1))
  const oneDay = todo({ notes: [{ at: NOW - 1000, by: 'human', text: `【推迟 ${today}】推迟 1 天` }] })
  assert.equal(isSnoozed(oneDay, NOW), true, 'today is still off')
  assert.equal(isSnoozed(oneDay, plusLocalDays(1)), false, 'tomorrow it is back')
  const threeDays = todo({ notes: [{ at: NOW - 1000, by: 'human', text: `【推迟 ${tomorrow}】推迟 3 天` }] })
  assert.equal(isSnoozed(threeDays, plusLocalDays(1)), true)
})
