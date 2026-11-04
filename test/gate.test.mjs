import { strict as assert } from 'node:assert'
import { homedir } from 'node:os'
import test from 'node:test'

import { budgetOf, dayKey, evaluate, isUnsafeDir, normalizePolicy, planDispatch } from '../lib/gate.js'

const NOW = Date.parse('2026-11-03T10:00:00+08:00')
const HOUR = 3_600_000
const DAY = 86_400_000

/** @param {object} [overrides] */
function todo(overrides = {}) {
  return {
    id: 't-00000001',
    seq: 1,
    title: '跑一遍静态检查',
    description: '',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    tags: ['可自动'],
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

const policy = normalizePolicy({ dailyCap: 2, cooldownDays: 3, denyDirs: ['/pool0', '/mnt/nas'] })

/** The same local time, `days` later: the suite may run in any timezone (CI is UTC). */
const plusLocalDays = (days) => {
  const date = new Date(NOW)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** @param {object} [overrides] */
function context(overrides = {}) {
  return { now: NOW, policy, usedToday: 0, byDir: {}, sessionAlive: false, ...overrides }
}

test('a record whose job is done is refused before anything else is asked', () => {
  assert.equal(evaluate(todo({ status: 'done' }), context()).code, 'not-active')
  assert.equal(evaluate(todo({ tags: ['inbox', '可自动'] }), context()).code, 'inbox')
})

test('without the tag nothing is dispatched, whatever the text says', () => {
  const verdict = evaluate(todo({ tags: [] }), context())
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'no-tag')
  assert.match(verdict.reason, /可自动/)
})

test('a record with no directory is refused: the worker would pick its own place', () => {
  assert.equal(evaluate(todo({ originDir: '' }), context()).code, 'no-dir')
})

test('the home directory itself is refused, a project below it is not', () => {
  // Exact, not prefix: this deployment works inside ~/workspace, so a prefix rule would
  // refuse every real project. The dangerous directory is home itself.
  assert.equal(isUnsafeDir(homedir()), true, 'the real home is denied')
  assert.equal(isUnsafeDir(`${homedir()}/workspace/x`), false)
  // A configured deny entry is a prefix on purpose: /pool0 and /mnt/nas are storage roots.
  assert.equal(isUnsafeDir('/pool0/data/x', ['/pool0']), true)
  assert.equal(isUnsafeDir('/srv/x', ['/pool0']), false)
  assert.equal(isUnsafeDir('C:', []), true)
  assert.equal(evaluate(todo({ originDir: '/pool0/data' }), context()).code, 'dir-unsafe')
})

test('a live session is already holding the record', () => {
  const verdict = evaluate(todo({ sessionId: 's-1' }), context({ sessionAlive: true }))
  assert.equal(verdict.code, 'already-live')
})

test('the same record waits out its cooldown, and says how long', () => {
  const verdict = evaluate(todo({ lastDispatch: { at: NOW - 2 * HOUR, ok: true } }), context())
  assert.equal(verdict.code, 'cooldown')
  assert.ok(verdict.waitHours > 60)
})

test('one directory at a time: a second worker in the same place can rewrite the first one work', () => {
  const verdict = evaluate(todo(), context({ byDir: { '/srv/demo': NOW - HOUR } }))
  assert.equal(verdict.code, 'dir-cooldown')
  assert.ok(verdict.waitHours > 60)
})

test('the daily cap is the last word, and zero means none', () => {
  assert.equal(evaluate(todo(), context({ usedToday: 2 })).code, 'daily-cap')
  const zero = normalizePolicy({ dailyCap: 0, denyDirs: ['/x'] })
  assert.equal(evaluate(todo(), { now: NOW, policy: zero, usedToday: 0, byDir: {}, sessionAlive: false }).code, 'daily-cap')
})

test('everything clear is allowed', () => {
  const verdict = evaluate(todo(), context())
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.code, 'allowed')
})

test('the budget counts today by the local calendar, not by UTC', () => {
  // Written without a fixed calendar string on purpose: the suite runs under whatever TZ the
  // machine has (CI is UTC), so the expectation has to be derived from the same rule, not from
  // a day that only exists in +08. `tz.test.mjs` states the convention.
  const sameDay = NOW - 1000
  const otherDay = NOW - 3 * DAY
  assert.notEqual(dayKey(sameDay), dayKey(otherDay))
  const report = budgetOf([
    todo({ id: 't-1', lastDispatch: { at: sameDay, ok: true, dir: '/a' } }),
    todo({ id: 't-2', lastDispatch: { at: otherDay, ok: true, dir: '/b' } }),
  ], NOW)
  assert.equal(report.day, dayKey(NOW))
  assert.equal(report.used, 1)
  assert.equal(report.byDir['/a'], sameDay)
  assert.equal(report.byDir['/b'], otherDay)
})

test('the policy clamps rather than trusting a hand-edited value', () => {
  const wild = normalizePolicy({ dailyCap: 99, cooldownDays: -3, denyDirs: [] }, { home: '/home/me' })
  assert.equal(wild.dailyCap, 10)
  assert.equal(wild.cooldownDays, 0)
  // An empty deny list would mean "anywhere", so the defaults come back instead.
  assert.ok(wild.denyDirs.includes('/pool0'))
})

test('the plan separates what may move from what may not, with reasons', () => {
  const plan = planDispatch([
    todo({ id: 't-1' }),
    todo({ id: 't-2', tags: [] }),
  ], { now: NOW, policy })
  assert.deepEqual(plan.allowed.map((entry) => entry.id), ['t-1'])
  assert.deepEqual(plan.refused.map((entry) => entry.code), ['no-tag'])
  assert.equal(plan.budget.day, dayKey(NOW))
})

test('a record deferred by a person is not dispatched over that decision', () => {
  const snoozed = todo({ notes: [{ at: NOW - 1000, by: 'human', text: '【推迟 2026-11-09】推迟 6 天' }] })
  assert.equal(evaluate(snoozed, context()).code, 'snoozed')
  // Once the day it names has passed, it is ordinary work again.
  const later = plusLocalDays(10)
  assert.equal(evaluate(snoozed, context({ now: later })).allowed, true)
})
