/**
 * Closing a record nobody handed over.
 *
 * The gap this covers: a todo written in the middle of a conversation could only be closed by the
 * model remembering a tool call or by a person clicking — measured on 2026-11-04, all 106 open
 * records had never been dispatched, so the hand-off watcher could not fire for a single one.
 *
 * Two positive signals are added here, and neither of them is silence (DESIGN.md: "Quiet is not a
 * verdict"). Both only ever file a *claim* — the record moves to 待确认 and a person still answers —
 * so a wrong guess costs one click instead of hiding unfinished work.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCompletionWatcher } from '../lib/completion.js'
import { STALE_DAYS, isStale } from '../lib/model.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-claims-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false } })
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    get: () => undefined,
  }
  const timers = []
  const watcher = createCompletionWatcher({
    ctx,
    service,
    logger: { info() {}, warn() {} },
    schedule: (milliseconds, callback) => {
      const handle = { milliseconds, callback }
      timers.push(handle)
      return handle
    },
    cancel: (handle) => {
      const index = timers.indexOf(handle)
      if (index >= 0) timers.splice(index, 1)
    },
  })
  const dispose = watcher.start()
  const emit = (sessionId, event) => listeners.get('session/event')({ id: sessionId }, event)
  const runTimers = () => {
    for (const handle of timers.splice(0, timers.length)) handle.callback()
  }
  return {
    service,
    watcher,
    emit,
    runTimers,
    dispose,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  }
}

/**
 * A todo written by `session` that names one file — and, because 0.22.0 gates agent records
 * without a deadline into the inbox, one that carries a deadline so it is really on the list.
 * The evidence path only ever claims work that is on the list; an inbox record is already a
 * question for a person.
 */
async function authored(service, sessionId, file, title = '改这个文件') {
  return service.create(
    { title, links: [file], dueAt: '2026-12-31T10:00' },
    { by: 'agent', source: 'tool', origin: { sessionId, dir: '/repo' } },
  )
}

const turnEnd = (kind = 'completed', turn = 1) => ({ type: 'turn/end', seq: 9, data: { turn, reason: { kind } } })
const changes = (files) => ({ type: 'workspace/changes', seq: 42, data: { files } })

test('a turn that changed the file a record names files a claim on it', async () => {
  const env = await harness()
  try {
    const todo = await authored(env.service, 'session-a', '/repo/src/app.js')
    assert.equal(todo.status, 'open')

    env.emit('session-a', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-a', turnEnd())
    env.emit('session-a', changes([{ path: '/repo/src/app.js', display: 'app.js' }]))
    await env.watcher.settled()

    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'done', 'the record files a claim, it does not stay open')
    assert.equal(stored.review?.pending, true, 'and the claim waits for a person')
    assert.equal(stored.completion.by, 'agent')
    assert.equal(stored.completion.sessionId, 'session-a')
    assert.match(stored.completion.summary, /app\.js/)
    assert.equal(stored.completion.artifacts[0].value, '/repo/src/app.js')
  } finally {
    env.dispose()
    await env.cleanup()
  }
})

test('a turn that touched a different file leaves the record alone', async () => {
  const env = await harness()
  try {
    const todo = await authored(env.service, 'session-a', '/repo/src/app.js')
    env.emit('session-a', turnEnd())
    env.emit('session-a', changes([{ path: '/repo/src/other.js', display: 'other.js' }]))
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'open')
  } finally {
    env.dispose()
    await env.cleanup()
  }
})

test('another conversation\'s record is never claimed, even for the same file', async () => {
  const env = await harness()
  try {
    const theirs = await authored(env.service, 'session-a', '/repo/src/app.js')
    // A second conversation that changed the same file has no business closing the first one's
    // record: authorship is the bound, not the file.
    env.emit('session-b', turnEnd())
    env.emit('session-b', changes([{ path: '/repo/src/app.js', display: 'app.js' }]))
    await env.watcher.settled()
    assert.equal((await env.service.get(theirs.id)).status, 'open')
  } finally {
    env.dispose()
    await env.cleanup()
  }
})

test('a failed turn claims nothing, even when it changed the file', async () => {
  const env = await harness()
  try {
    const todo = await authored(env.service, 'session-a', '/repo/src/app.js')
    env.emit('session-a', turnEnd('error'))
    env.emit('session-a', changes([{ path: '/repo/src/app.js', display: 'app.js' }]))
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'open', 'a failed attempt is not a finished job')
  } finally {
    env.dispose()
    await env.cleanup()
  }
})

test('a claim is not filed twice for the same record', async () => {
  const env = await harness()
  try {
    const todo = await authored(env.service, 'session-a', '/repo/src/app.js')
    env.emit('session-a', turnEnd())
    env.emit('session-a', changes([{ path: '/repo/src/app.js', display: 'app.js' }]))
    await env.watcher.settled()
    const first = await env.service.get(todo.id)

    // A second turn touches the same file. The record is already a claim, so nothing changes — in
    // particular the completion time and the summary stay from the turn that actually landed it.
    env.emit('session-a', turnEnd('completed', 2))
    env.emit('session-a', changes([{ path: '/repo/src/app.js', display: 'app.js' }]))
    await env.watcher.settled()
    const second = await env.service.get(todo.id)
    assert.equal(second.completion.at, first.completion.at)
  } finally {
    env.dispose()
    await env.cleanup()
  }
})

test('every step ticked by an agent files a claim; a person\'s tick does not', async () => {
  const env = await harness()
  try {
    const steps = [{ text: '一', done: false }, { text: '二', done: false }]
    const mine = await env.service.create({ title: '有步骤', steps }, { by: 'agent', source: 'tool', origin: { sessionId: 's', dir: '/r' } })

    // Half way: nothing happens.
    await env.service.update(mine.id, { steps: [{ text: '一', done: true }, { text: '二', done: false }] }, { by: 'agent' })
    assert.equal((await env.service.get(mine.id)).status, 'open')

    // The last step, from an agent: a claim.
    await env.service.update(mine.id, { steps: [{ text: '一', done: true }, { text: '二', done: true }] }, { by: 'agent' })
    const done = await env.service.get(mine.id)
    assert.equal(done.status, 'done')
    assert.equal(done.review?.pending, true, 'still a claim: a person answers')
    assert.match(done.completion.summary, /步骤全部完成/)

    // A person ticking boxes is tracking progress, not deciding. They have a 完成 button.
    const theirs = await env.service.create({ title: '人加的', steps }, { by: 'human', source: 'human' })
    await env.service.update(
      theirs.id,
      { steps: [{ text: '一', done: true }, { text: '二', done: true }] },
      { by: 'human' },
    )
    assert.equal((await env.service.get(theirs.id)).status, 'open')
  } finally {
    env.dispose()
    await env.cleanup()
  }
})

test('stale is three weeks untouched, and never about the inbox', () => {
  const now = Date.UTC(2026, 10, 4)
  const day = 86_400_000
  const base = { status: 'open', tags: [], createdAt: now - 60 * day, updatedAt: now - STALE_DAYS * day }
  assert.equal(isStale(base, now), true, 'exactly at the boundary counts')
  assert.equal(isStale({ ...base, updatedAt: now - (STALE_DAYS - 1) * day }, now), false)
  // A record somebody touched yesterday is not stale just because it was written a month ago.
  assert.equal(isStale({ ...base, updatedAt: now - day }, now), false)
  assert.equal(isStale({ ...base, status: 'done' }, now), false, 'a finished record is not a question')
  assert.equal(isStale({ ...base, tags: ['inbox'] }, now), false, 'the inbox is already a question')
  assert.equal(STALE_DAYS, 21)
})

test('the stale view answers with a filter, and counts it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-stale-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  try {
    const now = Date.now()
    const old = now - (STALE_DAYS + 3) * 86_400_000
    await store.write({
      version: 2,
      todos: [
        { id: 't-old', title: '三周没动', status: 'open', tags: [], createdAt: old, updatedAt: old },
        { id: 't-new', title: '刚刚动过', status: 'open', tags: [], createdAt: old, updatedAt: now },
      ],
      trash: [],
    })
    const service = createService({ store, config: { requireExistingFiles: false } })
    const stale = await service.list({ status: 'stale' })
    assert.deepEqual(stale.todos.map((todo) => todo.id), ['t-old'])
    assert.equal(stale.counts.stale, 1)
    // The filter is a view, not a status: the record is still open and still lists there.
    assert.equal(stale.todos[0].status, 'open')
    assert.ok((await service.list({ status: 'active' })).todos.some((todo) => todo.id === 't-old'))
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
