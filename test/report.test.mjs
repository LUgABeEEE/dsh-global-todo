import { strict as assert } from 'node:assert'
import test from 'node:test'

import { weeklyReport } from '../lib/report.js'

const NOW = Date.parse('2026-11-03T10:00:00+08:00')
const DAY = 86_400_000

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
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    ...overrides,
  }
}

test('the report carries the current triage shape, from the same rules as the tick', () => {
  const report = weeklyReport([
    todo({ id: 't-1', title: '等你定方案' }),
    todo({ id: 't-2', title: '整理备份', tags: ['可自动'] }),
    todo({ id: 't-3', title: '等对方回复邮件' }),
    todo({ id: 't-4', title: '随便看看' }),
  ], { now: NOW })
  assert.deepEqual(report.triage.buckets, { decision: 1, self: 1, external: 1, unknown: 1 })
  assert.equal(report.triage.counts.active, 4)
})

test('a deferred record is counted but not part of the backlog', () => {
  const report = weeklyReport([
    todo({ id: 't-1', notes: [{ at: NOW - DAY, by: 'human', text: '【推迟 2026-11-09】推迟 6 天' }] }),
  ], { now: NOW })
  assert.equal(report.triage.counts.snoozed, 1)
  assert.equal(report.triage.buckets.decision, 0, 'a deferred decision is not today business')
  assert.equal(report.triage.decisionBacklog.stale, 0)
})

test('what arrives is split by week, and by what kind of work it is', () => {
  const report = weeklyReport([
    todo({ id: 't-1', title: '等你定方案', createdAt: NOW - 2 * DAY }),
    todo({ id: 't-2', title: '整理备份', tags: ['可自动'], createdAt: NOW - 1 * DAY }),
    todo({ id: 't-3', title: '等对方回复', createdAt: NOW - 9 * DAY }),
    todo({ id: 't-4', title: '等你定顺序', createdAt: NOW - 30 * DAY }),
  ], { now: NOW, days: 7 })
  assert.equal(report.triage.incoming.now.decision, 1)
  assert.equal(report.triage.incoming.now.self, 1)
  assert.equal(report.triage.incoming.prev.external, 1)
  // Two weeks back is outside both windows: the report is about the last fourteen days.
  assert.equal(report.triage.incoming.prev.decision, 0)
})

test('an old decision backlog is reported with its age', () => {
  const report = weeklyReport([
    todo({ id: 't-1', title: '等你定方案', createdAt: NOW - 40 * DAY }),
    todo({ id: 't-2', title: '等你定顺序', createdAt: NOW - 20 * DAY }),
    todo({ id: 't-3', title: '整理备份', tags: ['可自动'], createdAt: NOW - 40 * DAY }),
  ], { now: NOW })
  assert.equal(report.triage.decisionBacklog.stale, 2)
  assert.equal(report.triage.decisionBacklog.oldestDays, 40)
})

test('an empty list still answers, with zeros rather than missing keys', () => {
  const report = weeklyReport([], { now: NOW })
  assert.equal(report.finished.length, 0)
  assert.deepEqual(report.triage.buckets, { decision: 0, self: 0, external: 0, unknown: 0 })
  assert.equal(report.triage.decisionBacklog.stale, 0)
})
