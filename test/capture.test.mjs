import { strict as assert } from 'node:assert'
import test from 'node:test'

import { CAPTURE_REASONS, findDuplicate, normalizeTitle, similarity } from '../lib/capture.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_700_000_000_000

test('titles fold to what they mean, keeping numbers and dates', () => {
  assert.equal(normalizeTitle('  把插件发到 NPM！ '), '把插件发到npm')
  assert.equal(normalizeTitle('Ｆｕｌｌ　ｗｉｄｔｈ'), 'fullwidth', 'NFKC handles full-width input')
  assert.equal(normalizeTitle('a-b_c'), 'abc')
  assert.notEqual(normalizeTitle('10 月 20 日交'), normalizeTitle('10 月 21 日交'), 'dates are not noise')
  assert.equal(normalizeTitle(undefined), '')
})

test('similarity separates a paraphrase from an unrelated errand', () => {
  assert.equal(similarity('把插件发到 npm', '把插件发到 npm'), 1)
  assert.ok(similarity('把插件发到 npm', '把插件发到 npm 上') >= 0.8)
  assert.ok(similarity('把插件发到 npm', '买咖啡') < 0.3)
  assert.equal(similarity('', 'anything'), 0)
})

test('the gate blocks the same errand and lets a genuinely new one through', () => {
  const base = { createdAt: NOW - 2 * HOUR, status: 'open', doneAt: null, updatedAt: NOW - 2 * HOUR }
  const existing = [
    { id: 't-1', title: '把插件发到 NPM', ...base },
    { id: 't-2', title: '整理会议纪要', ...base },
  ]

  const exact = findDuplicate({ title: '把插件发到npm！', existing, now: NOW })
  assert.deepEqual(exact, { duplicate: true, reason: 'same-active', matchId: 't-1' })

  const paraphrase = findDuplicate({ title: '把插件发到 npm 上去', existing, now: NOW })
  assert.equal(paraphrase.duplicate, true)
  assert.equal(paraphrase.reason, 'similar-active')

  assert.equal(findDuplicate({ title: '买咖啡', existing, now: NOW }).duplicate, false)
  assert.equal(findDuplicate({ title: '', existing, now: NOW }).duplicate, false)
})

test('a finished errand stays done for a week, and history does not block', () => {
  const done = { id: 't-3', title: '交实验报告', status: 'done', doneAt: NOW - 2 * DAY, createdAt: NOW - 9 * DAY, updatedAt: NOW - 2 * DAY }
  assert.deepEqual(
    findDuplicate({ title: '交实验报告', existing: [done], now: NOW }),
    { duplicate: true, reason: 'recently-done', matchId: 't-3' },
  )
  assert.equal(findDuplicate({ title: '交实验报告', existing: [done], now: NOW + 8 * DAY }).duplicate, false)

  const archived = { id: 't-4', title: '交实验报告', status: 'archived', doneAt: null, createdAt: NOW - DAY }
  assert.equal(findDuplicate({ title: '交实验报告', existing: [archived], now: NOW }).duplicate, false)
  const cancelled = { id: 't-5', title: '交实验报告', status: 'cancelled', doneAt: NOW - HOUR }
  assert.equal(findDuplicate({ title: '交实验报告', existing: [cancelled], now: NOW }).duplicate, false)
})

test('similarity only looks at the recent window', () => {
  const old = { id: 't-6', title: '把插件发到 npm', status: 'open', createdAt: NOW - 10 * DAY }
  // Same wording but ten days old: history, not a duplicate of today's phrasing.
  assert.equal(findDuplicate({ title: '把插件发到 npm 上', existing: [old], now: NOW }).duplicate, false)
  // An exact title is still a duplicate regardless of age, while it is still open.
  assert.equal(findDuplicate({ title: '把插件发到 npm', existing: [old], now: NOW }).reason, 'same-active')
})

test('every gate reason has a sentence', () => {
  for (const reason of ['same-active', 'similar-active', 'recently-done']) {
    assert.equal(typeof CAPTURE_REASONS[reason], 'string')
    assert.ok(CAPTURE_REASONS[reason].length > 0)
  }
})

test('a paraphrase of something finished minutes ago is still the same errand', () => {
  const existing = [
    { id: 't-done', title: '【插件测试】T3 逾期项 P0', status: 'done', createdAt: NOW - DAY, updatedAt: NOW - 60000, doneAt: NOW - 60000 },
  ]
  const exact = findDuplicate({ title: '【插件测试】T3 逾期项 P0', existing, now: NOW })
  assert.equal(exact.reason, 'recently-done')

  const paraphrase = findDuplicate({ title: '【插件测试】T3 逾期项 P0（再办一次）', existing, now: NOW })
  assert.equal(paraphrase.duplicate, true, 'the same errand with different wording')
  assert.equal(paraphrase.reason, 'similar-recently-done')
  assert.ok(CAPTURE_REASONS['similar-recently-done'].length > 0)

  const later = findDuplicate({ title: '【插件测试】T3 逾期项 P0（再办一次）', existing, now: NOW + 8 * DAY })
  assert.equal(later.duplicate, false, 'after the cooldown the errand may be written again')
})
