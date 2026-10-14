/**
 * The automatic-completion watcher.
 *
 * A hand-off must close itself when the work is done — and must NOT close when
 * the turn failed or when the user merely typed something in the conversation.
 * Both halves are the feature.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCompletionWatcher } from '../lib/completion.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-completion-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false } })
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    get(name) {
      if (name !== 'workspaceChanges') return undefined
      return {
        summary: (sessionId, seq) =>
          seq === 42 ? { files: [{ path: '/home/me/projects/p/from-service.md', display: 'from-service.md' }] } : undefined,
      }
    },
  }
  const warnings = []
  // A manual clock: the grace period must be observable, not slept through.
  const timers = []
  const watcher = createCompletionWatcher({
    ctx,
    service,
    logger: { info() {}, warn: (m) => warnings.push(m) },
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
  const emitReversed = (sessionId, event) => listeners.get('session/event')(event, { id: sessionId })
  const runTimers = () => {
    for (const handle of timers.splice(0, timers.length)) handle.callback()
  }
  /** Close a turn, leaving the change summary to arrive later (the real order). */
  const emitTurnEnd = (sessionId, kind, turn = 1) => emit(sessionId, turnEnd(kind, turn))
  /** Close a turn that will never announce changes: `turn/end`, then the grace period. */
  const finishTurn = (sessionId, kind, turn = 1) => {
    emitTurnEnd(sessionId, kind, turn)
    runTimers()
  }
  return {
    dir,
    service,
    watcher,
    emit,
    emitReversed,
    runTimers,
    finishTurn,
    emitTurnEnd,
    timers,
    dispose,
    warnings,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  }
}

const assistant = (text, turn = 1) => ({
  type: 'assistant/message',
  seq: 3,
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const changes = (files, seq = 42) => ({ type: 'workspace/changes', seq, data: { files } })
const turnEnd = (kind, turn = 1) => ({ type: 'turn/end', seq: 9, data: { turn, reason: { kind } } })

test('a finished turn closes the todo with the closing text and the changed files', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '写文档' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-1' })
    env.watcher.expect('session-1')

    env.emit('session-1', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-1', assistant('第一批内容'))
    env.emit('session-1', assistant('文档写完了，新增了 README 的一段'))
    env.emitTurnEnd('session-1', 'completed')
    // The Host appends the change summary *after* the turn closes.
    env.emit('session-1', changes([{ path: '/home/me/projects/p/README.md', display: 'README.md' }]))
    await env.watcher.settled()

    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'done')
    assert.equal(stored.completion.by, 'agent')
    assert.equal(stored.completion.sessionId, 'session-1')
    assert.match(stored.completion.summary, /文档写完了/)
    assert.equal(stored.completion.artifacts.length, 1)
    assert.equal(stored.completion.artifacts[0].value, '/home/me/projects/p/README.md')
    assert.equal(stored.completion.artifacts[0].title, 'README.md')
    assert.equal(stored.doneAt, stored.completion.at)
    assert.equal(env.watcher.expectCount(), 0, 'the expectation is consumed')
  } finally {
    await env.cleanup()
  }
})

test('a change event without the summary inline is resolved through the recorder', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'A' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-2' })
    env.watcher.expect('session-2')
    env.emit('session-2', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-2', assistant('done'))
    env.emitTurnEnd('session-2', 'completed')
    env.emit('session-2', changes([], 42))
    await env.watcher.settled()
    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'done')
    assert.equal(stored.completion.artifacts[0].value, '/home/me/projects/p/from-service.md')
  } finally {
    await env.cleanup()
  }
})

test('a failed turn leaves the todo open and drops the expectation', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'B' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-3' })
    env.watcher.expect('session-3')
    env.emit('session-3', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-3', assistant('我试了一下但报错了'))
    env.finishTurn('session-3', 'error')
    await env.watcher.settled()

    assert.equal((await env.service.get(todo.id)).status, 'open', 'a failure is not a finished job')
    assert.equal(env.watcher.expectCount(), 0, 'the stale expectation must not fire later')
    assert.equal(env.warnings.some((line) => line.includes('stays open')), true)

    // A later, clean turn in the same session cannot claim it either.
    env.emit('session-3', { type: 'turn/start', seq: 20, data: { turn: 2 } })
    env.emit('session-3', assistant('这次好了'))
    env.finishTurn('session-3', 'completed', 2)
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'open')
  } finally {
    await env.cleanup()
  }
})

test('a conversation the plugin did not dispatch to is never auto-completed', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'C' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-4' })
    // No expectation: the user is just talking in a session that happens to be bound.
    env.emit('session-4', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-4', assistant('顺便聊两句'))
    env.finishTurn('session-4', 'completed')
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'open')
  } finally {
    await env.cleanup()
  }
})

test('an aborted or interrupted turn is refused as well', async () => {
  const env = await harness()
  try {
    for (const kind of ['aborted', 'interrupted', 'max-tokens']) {
      const todo = await env.service.create({ title: `D-${kind}` })
      await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: `session-${kind}` })
      env.watcher.expect(`session-${kind}`)
      env.emit(`session-${kind}`, { type: 'turn/start', seq: 1, data: { turn: 1 } })
      env.emit(`session-${kind}`, assistant('中断了'))
      env.finishTurn(`session-${kind}`, kind)
      await env.watcher.settled()
      assert.equal((await env.service.get(todo.id)).status, 'open', kind)
    }
  } finally {
    await env.cleanup()
  }
})

test('the listener tolerates either argument order and junk payloads', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'E' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-5' })
    env.watcher.expect('session-5')
    // The listener is reached with swapped arguments as well: the harness calls
    // it the same way Cordis does, and the watcher must not care about order.
    env.emitReversed('session-5', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emitReversed('session-5', assistant('ok'))
    env.emitReversed('session-5', turnEnd('completed'))
    env.runTimers()
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'done')

    env.emit('session-5', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-5', assistant('ok'))
    env.finishTurn('session-5', 'completed')
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'done')

    // Junk must be ignored, not thrown.
    env.emit('session-6', { type: 'turn/end', seq: 1, data: {} })
    env.emit('session-6', {})
    assert.equal(env.warnings.length, 0, 'junk payloads are silent')
  } finally {
    await env.cleanup()
  }
})

test('an agent that decided for itself is not overruled', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '做不完的活' })
    await env.service.recordDispatch(todo.id, { mode: 'current', ok: true, sessionId: 'session-7' })
    env.watcher.expect('session-7')
    env.emit('session-7', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    // The agent wrote a blocker note through the plugin's own tool.
    env.emit('session-7', { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'global_todo_update', arguments: '{}' } })
    env.emit('session-7', assistant('这件事卡在需要你授权：git 提交和 npm 发布我做不了。'))
    env.finishTurn('session-7', 'completed')
    await env.watcher.settled()

    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'open', 'a stated blocker must not become a completion')
    assert.equal(stored.completion, null)
    assert.equal(env.watcher.expectCount(), 0)
  } finally {
    await env.cleanup()
  }
})

test('a read-only tool call does not count as deciding', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '只看了一眼' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-8' })
    env.watcher.expect('session-8')
    env.emit('session-8', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-8', { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'global_todo_list', arguments: '{}' } })
    env.emit('session-8', assistant('看完了，也做完了'))
    env.finishTurn('session-8', 'completed')
    await env.watcher.settled()

    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'done', 'a lookup is not a verdict')
    assert.match(stored.completion.summary, /看完了/)
  } finally {
    await env.cleanup()
  }
})

test('a new turn starts with a clean slate for the decision flag', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'A' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-9' })
    env.watcher.expect('session-9')
    // Turn 1: a verdict tool, but the turn fails.
    env.emit('session-9', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-9', { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'global_todo_update', arguments: '{}' } })
    env.finishTurn('session-9', 'error')
    await env.watcher.settled()
    // Turn 2: a fresh hand-off, no verdict tool this time.
    env.watcher.expect('session-9')
    env.emit('session-9', { type: 'turn/start', seq: 10, data: { turn: 2 } })
    env.emit('session-9', assistant('这次真做完了'))
    env.finishTurn('session-9', 'completed', 2)
    await env.watcher.settled()
    assert.equal((await env.service.get(todo.id)).status, 'done', 'the old flag must not leak into a new turn')
  } finally {
    await env.cleanup()
  }
})

test('the change summary is waited for instead of recording an empty artifact list', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '改了几个文件' })
    await env.service.recordDispatch(todo.id, { mode: 'current', ok: true, sessionId: 'session-10' })
    env.watcher.expect('session-10')
    env.emit('session-10', { type: 'turn/start', seq: 1, data: { turn: 3 } })
    env.emit('session-10', assistant('改完了'))
    env.emit('session-10', turnEnd('completed', 3))

    // The turn closed, but the recorder has not announced its diff yet.
    assert.equal(env.watcher.waitingCount(), 1)
    assert.equal((await env.service.get(todo.id)).status, 'open', 'nothing may be written before the summary lands')

    env.emit('session-10', { type: 'workspace/changes', seq: 42, data: { turn: 3, files: [{ path: '/p/a.md', display: 'a.md' }] } })
    await env.watcher.settled()

    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'done')
    assert.equal(stored.completion.artifacts.length, 1, 'the late summary must be used')
    assert.equal(stored.completion.artifacts[0].value, '/p/a.md')
    assert.equal(env.watcher.waitingCount(), 0)
  } finally {
    await env.cleanup()
  }
})

test('a turn that changed nothing still completes when the grace period ends', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '只是回答了一句' })
    await env.service.recordDispatch(todo.id, { mode: 'current', ok: true, sessionId: 'session-11' })
    env.watcher.expect('session-11')
    env.emit('session-11', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-11', assistant('没有要改的东西'))
    env.emit('session-11', turnEnd('completed', 1))
    assert.equal(env.timers.length, 1, 'a bound wait must be armed')
    assert.equal(env.timers[0].milliseconds, 2500)
    env.runTimers()
    await env.watcher.settled()

    const stored = await env.service.get(todo.id)
    assert.equal(stored.status, 'done')
    assert.deepEqual(stored.completion.artifacts, [])
    assert.match(stored.completion.summary, /没有要改的东西/)
  } finally {
    await env.cleanup()
  }
})

test('a new turn settles the previous wait instead of leaking it', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'A' })
    await env.service.recordDispatch(todo.id, { mode: 'current', ok: true, sessionId: 'session-12' })
    env.watcher.expect('session-12')
    env.emit('session-12', { type: 'turn/start', seq: 1, data: { turn: 1 } })
    env.emit('session-12', assistant('第一轮'))
    env.emit('session-12', turnEnd('completed', 1))
    assert.equal(env.watcher.waitingCount(), 1)
    // A new turn starts before the summary of the old one arrived.
    env.emit('session-12', { type: 'turn/start', seq: 9, data: { turn: 2 } })
    await env.watcher.settled()
    assert.equal(env.watcher.waitingCount(), 0)
    assert.equal((await env.service.get(todo.id)).status, 'done')
  } finally {
    await env.cleanup()
  }
})

test('without the event surface the watcher stays off instead of breaking', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-completion-'))
  try {
    const store = createStore({ file: path.join(dir, 'todos.json') })
    const service = createService({ store, config: { requireExistingFiles: false } })
    const watcher = createCompletionWatcher({ ctx: {}, service, logger: { info() {}, warn() {} } })
    const dispose = watcher.start()
    assert.equal(typeof dispose, 'function')
    dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
