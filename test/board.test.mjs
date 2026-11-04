/**
 * Keeping the board short enough that somebody reads it.
 *
 * Measured before this existed (2026-11-04): 98 unfinished records, ~3 closed on a typical day,
 * 4 due within 24 hours, and not one record older than 14 days untouched — so this was never a
 * "delete the zombies" problem. The board simply grew faster than it drained, and a board that
 * takes a month to clear is a board nobody opens.
 *
 * Two mechanisms, and neither decides that any work is finished:
 *
 *  - **park** (`someday`): a record that is real but not today's problem. Off the board, out of
 *    its counts, one click back.
 *  - **a board budget** (`listLimit`): when it is full, an agent-written record waits in the inbox
 *    with the reason, exactly like an undated one. Nothing is dropped.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { boardSize, createService, LIST_LIMIT } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { counts, isSomeday, SOMEDAY_TAG } from '../lib/model.js'

async function harness(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-board-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false, ...config } })
  return { dir, store, service, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }) }
}

const deadline = '2026-12-31T10:00'

test('a parked record leaves the board and takes its counts with it', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '这条不急', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.equal((await env.service.list({ status: 'active' })).todos.length, 1)

    await env.service.update(todo.id, { tags: [SOMEDAY_TAG] }, { by: 'human' })
    const active = await env.service.list({ status: 'active' })
    assert.equal(active.todos.length, 0, 'off the board')
    assert.equal(active.counts.someday, 1, 'and counted in its own bucket')
    assert.equal(active.counts.total, 0, 'the board count describes the board, not the file')
    assert.equal(active.todos.some((item) => item.id === todo.id), false)

    // Still there, still open, one filter away.
    const parked = await env.service.list({ status: 'someday' })
    assert.deepEqual(parked.todos.map((item) => item.id), [todo.id])
    assert.equal(parked.todos[0].status, 'open', 'parking is not a decision about the work')

    // And back again.
    await env.service.update(todo.id, { tags: [] }, { by: 'human' })
    assert.equal((await env.service.list({ status: 'active' })).todos.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('a full board sends the next agent record to the inbox, and drops nothing', async () => {
  const env = await harness({ listLimit: 2 })
  try {
    const first = await env.service.create({ title: 'A', dueAt: deadline }, { by: 'agent', source: 'tool' })
    const second = await env.service.create({ title: 'B', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.equal((first.tags ?? []).includes('inbox'), false)
    assert.equal((second.tags ?? []).includes('inbox'), false)

    const third = await env.service.create({ title: 'C', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.ok((third.tags ?? []).includes('inbox'), 'the third waits instead of joining')
    assert.equal(third.inboxReason, 'list-full', 'and says why')
    assert.equal((await env.service.list({ status: 'active' })).todos.length, 2, 'the board did not grow')

    // Closing one opens the door again; nothing had to be deleted to make room.
    await env.service.complete(second.id, { summary: '做完了' }, { by: 'human' })
    const fourth = await env.service.create({ title: 'D', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.equal((fourth.tags ?? []).includes('inbox'), false)
  } finally {
    await env.cleanup()
  }
})

test('a person is never turned away by their own board limit', async () => {
  const env = await harness({ listLimit: 1 })
  try {
    await env.service.create({ title: 'agent 写的', dueAt: deadline }, { by: 'agent', source: 'tool' })
    const mine = await env.service.create({ title: '我自己加的', dueAt: deadline }, { by: 'human', source: 'human' })
    assert.equal((mine.tags ?? []).includes('inbox'), false, 'a limit that refuses its owner is the plugin arguing')
    // The board is now over budget — that is visible, not prevented.
    const active = await env.service.list({ status: 'active' })
    assert.equal(active.todos.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('parked records do not count against the budget', async () => {
  const env = await harness({ listLimit: 1 })
  try {
    const first = await env.service.create({ title: 'A', dueAt: deadline }, { by: 'agent', source: 'tool' })
    await env.service.update(first.id, { tags: [SOMEDAY_TAG] }, { by: 'human' })
    const second = await env.service.create({ title: 'B', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.equal((second.tags ?? []).includes('inbox'), false, 'a parked record freed the slot')
  } finally {
    await env.cleanup()
  }
})

test('0 disables the cap, so a deployment can opt out', async () => {
  // `0` is the escape hatch, and it must not quietly re-enable itself through the normalizer.
  // The daily allowance is a different gate and still applies — that is why this asserts on the
  // reason rather than on "nothing ever waits".
  const env = await harness({ listLimit: 0 })
  try {
    for (let index = 0; index < 12; index += 1) {
      const todo = await env.service.create({ title: 'row ' + index, dueAt: deadline }, { by: 'agent', source: 'tool' })
      assert.notEqual(todo.inboxReason, 'list-full', 'the board never fills when the cap is off')
    }
  } finally {
    await env.cleanup()
  }
})

test('the limit is read on every create, not captured once', async () => {
  // The panel changes this while the plugin is running; a value folded into the service at mount
  // would make the switch look saved and do nothing until a restart.
  let limit = 1
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-board-live-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  try {
    const service = createService({ store, config: { requireExistingFiles: false, listLimit: () => limit } })
    await service.create({ title: 'A', dueAt: deadline }, { by: 'agent', source: 'tool' })
    const gated = await service.create({ title: 'B', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.equal(gated.inboxReason, 'list-full')

    limit = 0
    const allowed = await service.create({ title: 'C', dueAt: deadline }, { by: 'agent', source: 'tool' })
    assert.equal((allowed.tags ?? []).includes('inbox'), false, 'turning it off takes effect immediately')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('the budget numbers agree with the records', async () => {
  const env = await harness({ listLimit: 2 })
  try {
    await env.service.create({ title: 'board 1', dueAt: deadline }, { by: 'agent', source: 'tool' })
    const parked = await env.service.create({ title: 'parked', dueAt: deadline }, { by: 'agent', source: 'tool' })
    await env.service.update(parked.id, { tags: [SOMEDAY_TAG] }, { by: 'human' })
    const gated = await env.service.create({ title: 'board 2', dueAt: deadline }, { by: 'agent', source: 'tool' })
    await env.service.create({ title: 'waits', dueAt: deadline }, { by: 'agent', source: 'tool' })

    const all = await env.store.all()
    assert.equal(boardSize(all), 2, 'the board size is derived, never counted separately')
    const summary = counts(all)
    assert.equal(summary.someday, 1)
    assert.equal(summary.total, 2, 'inbox rows are outside the board count')
    assert.equal((gated.tags ?? []).includes('inbox'), false)
  } finally {
    await env.cleanup()
  }
})

test('the default budget is twenty', () => {
  assert.equal(LIST_LIMIT, 20)
  assert.equal(isSomeday({ tags: ['SOMEDAY'] }), true, 'the tag is matched case-insensitively')
  assert.equal(isSomeday({ tags: ['other'] }), false)
})

test('confirming out of the inbox cannot walk past a full board', async () => {
  // The hole this closes, measured on 2026-11-04: the 0.22.0 sweep moved 68 records into the
  // inbox, and 37 of them were confirmed back onto the board within six days. Intake to the board
  // had halved, the board stayed at ~93 — the gate was a formality because 收下 was free.
  const env = await harness({ listLimit: 1 })
  try {
    const first = await env.service.create({ title: 'A', dueAt: deadline }, { by: 'agent', source: 'tool' })
    const waiting = await env.service.create({ title: 'B' }, { by: 'agent', source: 'tool' })
    assert.equal(waiting.inboxReason, 'no-due', 'no deadline, so it waits')

    await assert.rejects(
      () => env.service.update(waiting.id, { tags: [] }, { by: 'agent' }),
      (error) => error.code === 'list-full',
      'an agent cannot confirm a record onto a full board',
    )
    assert.ok((await env.service.get(waiting.id)).tags.includes('inbox'), 'the record stayed where it was')

    // A person is the owner: the number goes over budget, the click is not blocked.
    await env.service.update(waiting.id, { tags: [] }, { by: 'human' })
    assert.equal((await env.service.get(waiting.id)).tags.includes('inbox'), false)

    // And closing makes room for the agent path too: the refusal is about the state, not a
    // permanent ban on the record.
    await env.service.complete(first.id, { summary: '关掉一条' }, { by: 'human' })
    await env.service.complete(waiting.id, { summary: '另一条也关了' }, { by: 'human' })
    const third = await env.service.create({ title: 'C' }, { by: 'agent', source: 'tool' })
    await env.service.update(third.id, { tags: [] }, { by: 'agent' })
    assert.equal((await env.service.get(third.id)).tags.includes('inbox'), false)
  } finally {
    await env.cleanup()
  }
})
