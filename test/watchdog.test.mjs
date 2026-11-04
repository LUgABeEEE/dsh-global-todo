import { strict as assert } from 'node:assert'
import test from 'node:test'

import { STALL_HOURS, findStalled } from '../lib/watchdog.js'

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
    lastDispatch: { at: NOW - 26 * HOUR, ok: true, mode: 'new', sessionId: 's-1', dir: '/srv/demo' },
    createdAt: NOW - DAY,
    updatedAt: NOW - 26 * HOUR,
    ...overrides,
  }
}

test('a hand-off younger than a day is not stalled yet', () => {
  assert.deepEqual(findStalled([todo({ lastDispatch: { at: NOW - HOUR, ok: true } })], { now: NOW }), [])
  assert.equal(STALL_HOURS, 24)
})

test('silence past the threshold is named, with how long it has been', () => {
  const stalled = findStalled([todo()], { now: NOW })
  assert.equal(stalled.length, 1)
  assert.equal(stalled[0].id, 't-00000001')
  assert.equal(stalled[0].hours, 26)
  assert.equal(stalled[0].live, false)
})

test('the hand-off its own trail is not progress, but a note after it is', () => {
  const dispatchedOnly = todo({
    activity: [{ kind: 'dispatched', by: 'human', at: NOW - 26 * HOUR, summary: 'new → s-1' }],
  })
  assert.equal(findStalled([dispatchedOnly], { now: NOW }).length, 1)

  const withNote = todo({
    activity: [{ kind: 'dispatched', by: 'human', at: NOW - 26 * HOUR, summary: 'new → s-1' }],
    notes: [{ at: NOW - 2 * HOUR, by: 'agent', text: '已经跑了一半' }],
  })
  assert.deepEqual(findStalled([withNote], { now: NOW }), [])
})

test('any later activity counts too, not only notes', () => {
  const touched = todo({
    activity: [
      { kind: 'dispatched', by: 'human', at: NOW - 26 * HOUR, summary: 'new → s-1' },
      { kind: 'updated', by: 'agent', at: NOW - 3 * HOUR, summary: '改了截止时间' },
    ],
  })
  assert.deepEqual(findStalled([touched], { now: NOW }), [])
})

test('a failed hand-off is not a stalled one', () => {
  assert.deepEqual(findStalled([todo({ lastDispatch: { at: NOW - 26 * HOUR, ok: false, error: '不许' } })], { now: NOW }), [])
})

test('only live records are watched', () => {
  assert.deepEqual(findStalled([todo({ status: 'done' })], { now: NOW }), [])
  assert.deepEqual(findStalled([todo({ status: 'archived' })], { now: NOW }), [])
})

test('liveness travels with the finding, so the note can say which case it is', () => {
  const stalled = findStalled([todo()], { now: NOW, sessionAlive: () => true })
  assert.equal(stalled[0].live, true)
})

test('the plugin own notes are not progress: a triage line must not hide a stall', () => {
  // The daily tick writes 【分诊 …】 onto records it mentions. Counting that as "something
  // happened" would make every mentioned record look alive forever.
  const announced = todo({
    activity: [
      { kind: 'dispatched', by: 'human', at: NOW - 26 * HOUR, summary: 'new → s-1' },
      { kind: 'noted', by: 'agent', at: NOW - HOUR, summary: '【分诊 2026-11-03】今日第 1/3 条 · 该你一句话' },
    ],
    notes: [{ at: NOW - HOUR, by: 'agent', text: '【分诊 2026-11-03】今日第 1/3 条 · 该你一句话' }],
  })
  const stalled = findStalled([announced], { now: NOW })
  assert.equal(stalled.length, 1, 'a bookkeeping note hid the stall')
  assert.equal(stalled[0].hours, 26)
})

test('a person note after the hand-off still counts as progress', () => {
  const touched = todo({
    activity: [{ kind: 'dispatched', by: 'human', at: NOW - 26 * HOUR, summary: 'new → s-1' }],
    notes: [{ at: NOW - HOUR, by: 'human', text: '问过对方了，还在等' }],
  })
  assert.deepEqual(findStalled([touched], { now: NOW }), [])
})
