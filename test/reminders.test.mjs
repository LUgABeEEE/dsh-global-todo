import { strict as assert } from 'node:assert'
import test from 'node:test'

import { dueReminders } from '../lib/reminders.js'

const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const base = { status: 'open', dueAt: '2026-10-19T10:00:00.000Z', seq: 7, title: '交报告' }

test('only active, past-due, not-yet-announced records are reminders', () => {
  const past = { ...base }
  assert.deepEqual(dueReminders([past], { now: NOW }), [{ id: undefined, seq: 7, title: '交报告', dueAt: base.dueAt }])
  assert.equal(dueReminders([{ ...past, id: 't-1' }], { now: Date.parse('2026-10-19T09:00:00Z') }).length, 0)
  assert.equal(dueReminders([{ ...past, id: 't-1', status: 'done' }], { now: NOW }).length, 0)
  assert.equal(dueReminders([{ ...past, id: 't-1', status: 'archived' }], { now: NOW }).length, 0)
  assert.equal(dueReminders([{ ...past, id: 't-1', dueAt: null }], { now: NOW }).length, 0)
})

test('a lead time announces before the deadline', () => {
  const todo = { ...base, id: 't-lead' }
  const before = Date.parse('2026-10-19T09:55:00Z')
  assert.equal(dueReminders([todo], { now: before }).length, 0)
  assert.equal(dueReminders([todo], { now: before, leadMs: 10 * 60 * 1000 }).length, 1)
})

test('announced reminders stay quiet until the deadline changes', () => {
  const todo = { ...base, id: 't-1' }
  assert.equal(dueReminders([todo], { now: NOW, reminded: { 't-1': base.dueAt } }).length, 0)
  // Postponed: the new deadline is a new reminder.
  const moved = { ...todo, dueAt: '2026-10-19T11:00:00.000Z' }
  assert.equal(dueReminders([moved], { now: Date.parse('2026-10-19T12:00:00Z'), reminded: { 't-1': base.dueAt } }).length, 1)
})
