import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDispatcher } from '../lib/dispatch.js'
import { createMetrics } from '../lib/metrics.js'
import { ROUTE_BASE, createRoutes } from '../lib/routes.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-metrics-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const metrics = createMetrics()
  const service = createService({ store, config: { requireExistingFiles: false }, metrics })
  const sent = []
  const agents = {
    get: (id) =>
      id === 'session-live'
        ? { id, status: 'idle', followup: (message) => sent.push(message) }
        : undefined,
  }
  const dispatcher = createDispatcher({
    ctx: { get: (name) => (name === 'agents' ? agents : undefined) },
    service,
    metrics,
  })
  const tools = createTools(service, { metrics })
  return { dir, metrics, service, dispatcher, sent, tools, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A response double, the same shape the routes tests use. */
function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    setHeader() {},
    end(chunk) {
      this.body = chunk ?? ''
      this.writableEnded = true
    },
  }
}

function makeReq(method, url) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  }
}

test('the counters start empty, and a rate with no attempts is null', () => {
  const metrics = createMetrics({ now: () => 1000 })
  const snapshot = metrics.snapshot()
  assert.equal(snapshot.since, 1000)
  assert.equal(snapshot.uptimeMs, 0)
  assert.deepEqual(snapshot.list, {
    created: 0,
    removed: 0,
    restored: 0,
    imports: 0,
    noted: 0,
    changes: 0,
    size: null,
    peak: null,
    lastChangeAt: null,
  })
  assert.deepEqual(snapshot.dispatch, {
    attempts: 0,
    ok: 0,
    failed: 0,
    byMode: {},
    lastAt: null,
    successRate: null,
  })
  assert.deepEqual(snapshot.tools, { calls: 0, failed: 0, byName: {} })
})

test('every counter adds up, and peak keeps the high-water mark', () => {
  const metrics = createMetrics({ now: () => 5 })
  metrics.recordDispatch({ ok: true, mode: 'new' })
  metrics.recordDispatch({ ok: false, mode: 'auto' })
  metrics.recordTool('global_todo_add', true)
  metrics.recordTool('global_todo_add', false)
  metrics.recordTool('global_todo_list', true)
  metrics.recordList('created', 3)
  metrics.recordList('created', 2)
  metrics.observeSize(9)
  metrics.recordList('removed', 1)
  metrics.recordList('noted')

  const snapshot = metrics.snapshot()
  assert.equal(snapshot.dispatch.attempts, 2)
  assert.equal(snapshot.dispatch.ok, 1)
  assert.equal(snapshot.dispatch.failed, 1)
  assert.equal(snapshot.dispatch.successRate, 0.5)
  assert.deepEqual(snapshot.dispatch.byMode, { new: 1, auto: 1 })
  assert.deepEqual(snapshot.tools, {
    calls: 3,
    failed: 1,
    byName: { global_todo_add: 2, global_todo_list: 1 },
  })
  assert.equal(snapshot.list.created, 2)
  assert.equal(snapshot.list.removed, 1)
  assert.equal(snapshot.list.noted, 1)
  assert.equal(snapshot.list.changes, 4)
  assert.equal(snapshot.list.size, 1, 'the size follows the last recorded change')
  assert.equal(snapshot.list.peak, 9, 'a later size must not lower the peak')
  assert.equal(snapshot.list.lastChangeAt, 5)
})

test('a hand-off is counted once, whether it succeeds or throws', async () => {
  const env = await harness()
  try {
    const ok = await env.service.create({ title: '交给活着的会话' })
    const result = await env.dispatcher.dispatch(ok.id, { mode: 'bound', sessionId: 'session-live' })
    assert.equal(result.sessionId, 'session-live')
    assert.equal(env.sent.length, 1, 'the hand-off really went out')

    const doomed = await env.service.create({ title: '交给没了的会话' })
    await assert.rejects(() => env.dispatcher.dispatch(doomed.id, { mode: 'bound', sessionId: 'session-gone' }))

    const snapshot = env.metrics.snapshot()
    assert.equal(snapshot.dispatch.attempts, 2)
    assert.equal(snapshot.dispatch.ok, 1)
    assert.equal(snapshot.dispatch.failed, 1)
    assert.equal(snapshot.dispatch.successRate, 0.5)
    assert.deepEqual(snapshot.dispatch.byMode, { bound: 2 })
  } finally {
    await env.cleanup()
  }
})

test('agent tool calls are counted per name, and a refused call is a failure', async () => {
  const env = await harness()
  try {
    const byName = new Map(env.tools.map((tool) => [tool.name, tool]))
    const added = await byName.get('global_todo_add').execute({ title: '写 README' })
    assert.equal(added.ok, true)
    const missing = await byName.get('global_todo_get').execute({ id: 't-nope' })
    assert.equal(missing.ok, false)

    const snapshot = env.metrics.snapshot()
    assert.deepEqual(snapshot.tools, {
      calls: 2,
      failed: 1,
      byName: { global_todo_add: 1, global_todo_get: 1 },
    })
  } finally {
    await env.cleanup()
  }
})

test('list mutations are counted as they happen', async () => {
  const env = await harness()
  try {
    const first = await env.service.create({ title: 'A' })
    const second = await env.service.create({ title: 'B' })
    await env.service.note(first.id, '做到一半')
    await env.service.remove(second.id)
    await env.service.restore({ ...second })

    const snapshot = env.metrics.snapshot()
    assert.equal(snapshot.list.created, 2)
    assert.equal(snapshot.list.noted, 1)
    assert.equal(snapshot.list.removed, 1)
    assert.equal(snapshot.list.restored, 1)
    assert.equal(snapshot.list.changes, 5)
    assert.equal(snapshot.list.size, 2)
  } finally {
    await env.cleanup()
  }
})

test('/health reports the counters without changing the fields around them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-health-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const metrics = createMetrics()
  const service = createService({ store, config: { requireExistingFiles: false }, metrics })
  const dispatcher = { capabilities: () => ({ agents: true }), sessionAlive: () => false, sessionDir: () => '' }
  const routes = createRoutes({ service, dispatcher, version: '0.1.0-test', metrics })
  try {
    await service.create({ title: 'A' })
    await service.create({ title: 'B' })

    const route = routes.find((candidate) => candidate.path === ROUTE_BASE + '/health')
    const response = makeRes()
    await route.handler(makeReq('GET', ROUTE_BASE + '/health'), response)
    const payload = JSON.parse(response.body)

    assert.equal(payload.ok, true)
    assert.equal(payload.data.counts.total, 2)
    assert.equal(payload.data.metrics.list.created, 2)
    assert.equal(payload.data.metrics.list.size, 2)
    assert.equal(payload.data.metrics.list.peak, 2)
    assert.equal(payload.data.metrics.dispatch.successRate, null, 'no attempt is not a zero rate')
    // The pre-existing fields are untouched.
    assert.equal(payload.data.version, '0.1.0-test')
    assert.equal(payload.data.dispatch.agents, true)
    assert.equal(payload.data.fence.localScriptsAdmitted, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('/health says null when no counters were mounted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-health-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false } })
  const dispatcher = { capabilities: () => ({}), sessionAlive: () => false, sessionDir: () => '' }
  const routes = createRoutes({ service, dispatcher, version: '0.1.0-test' })
  try {
    const route = routes.find((candidate) => candidate.path === ROUTE_BASE + '/health')
    const response = makeRes()
    await route.handler(makeReq('GET', ROUTE_BASE + '/health'), response)
    const payload = JSON.parse(response.body)
    assert.equal(payload.data.metrics, null, 'an absent metric is not a zero')
    assert.equal(payload.data.counts.total, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
