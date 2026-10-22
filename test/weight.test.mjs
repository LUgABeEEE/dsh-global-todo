import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_MIN_WEIGHT, normalizeThreshold, scoreItem } from '../lib/weight.js'

test('a stated errand with a deadline outscores anything hedged', () => {
  const strong = scoreItem({ title: '记得下周把周报模板换成四段式，周五前发我', description: '含字段清单', dueAt: '2026-10-31T18:00' })
  const hedged = scoreItem({ title: '可能要看看那个日志' })
  assert.ok(strong.weight >= 0.7, `got ${strong.weight}`)
  assert.ok(hedged.weight < DEFAULT_MIN_WEIGHT, `hedged ${hedged.weight} should fall below the default`)
})

test('a bare but real errand still passes the default threshold', () => {
  // "取快递" is short and has no metadata, but it is an errand, not an aside — the default
  // threshold has to sit between this and a hedged one-liner.
  assert.ok(scoreItem({ title: '取快递' }).weight >= DEFAULT_MIN_WEIGHT)
})

test('asides and questions fall below the default', () => {
  for (const title of ['可能要去看看那个日志', '要不要考虑重构?', 'X', '回头再说吧，有空看看']) {
    const { weight } = scoreItem({ title })
    assert.ok(weight < DEFAULT_MIN_WEIGHT, `${title} scored ${weight}`)
  }
})

test('every contribution is named, so a skip can say why', () => {
  const { signals } = scoreItem({ title: '可能要去看看那个日志' })
  const ids = signals.map((signal) => signal.id)
  assert.ok(ids.includes('hesitation'))
  assert.ok(ids.includes('naked'))
  const strong = scoreItem({ title: '记得发我', dueAt: '2026-11-01', steps: ['一'], links: [{ kind: 'url', value: 'https://example.com' }], evidence: '原话' })
  assert.ok(strong.signals.some((signal) => signal.id === 'due'))
  assert.ok(strong.signals.some((signal) => signal.id === 'steps'))
  assert.ok(strong.signals.some((signal) => signal.id === 'evidence'))
  assert.ok(strong.signals.some((signal) => signal.id === 'commitment'))
})

test('a non-object scores zero instead of throwing', () => {
  for (const value of [null, 'x', 42, []]) assert.equal(scoreItem(value).weight, 0)
})

test('the threshold normalizes to 0..1 with a fallback', () => {
  assert.equal(normalizeThreshold(2), 1)
  assert.equal(normalizeThreshold(-1), 0)
  assert.equal(normalizeThreshold('0.5'), 0.5)
  assert.equal(normalizeThreshold('nope'), DEFAULT_MIN_WEIGHT)
  assert.equal(normalizeThreshold(undefined), DEFAULT_MIN_WEIGHT)
})
