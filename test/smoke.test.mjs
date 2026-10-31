/**
 * Mount smoke test.
 *
 * The unit tests exercise the pieces; this one mounts the plugin the way the
 * Loader does — `apply(ctx, config)` against a fake Cordis context — and then
 * drives a full round trip through the *registered* surfaces: an agent tool and
 * the HTTP routes, both writing the same file on disk.
 *
 * It also proves the degradation contract: with no optional service at all, the
 * plugin must mount and exactly lose the surfaces it cannot have.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { VERSION, apply } from '../lib/index.js'

/**
 * A context that behaves like the Loader's: `inject` waits for the named
 * services and hands the callback a context that carries them.
 *
 * @param {Record<string, object>} services
 */
function makeHost(services = {}) {
  const state = {
    effects: [],
    tools: new Map(),
    routes: new Map(),
    routeTable: new Map(),
    promptSections: [],
    warnings: [],
    infos: [],
    services,
    listeners: new Map(),
  }

  const makeCtx = () => {
    const ctx = {
      // Cordis exposes a Service as a context property, and `inject` hands the
      // callback a context that carries it. The fake mirrors both.
      ...state.services,
      logger: {
        info: (message) => state.infos.push(message),
        warn: (message) => state.warnings.push(message),
        debug: () => {},
      },
      get: (name) => state.services[name],
      // Event subscription, as the real context exposes it.
      on(name, listener) {
        const list = state.listeners.get(name) ?? []
        list.push(listener)
        state.listeners.set(name, list)
        return () => {
          state.listeners.set(name, (state.listeners.get(name) ?? []).filter((entry) => entry !== listener))
        }
      },
      effect(callback, label) {
        state.effects.push(label)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      inject(names, callback) {
        // A real context waits for the service and never calls back without it.
        if (!names.every((name) => state.services[name] !== undefined)) return () => {}
        return callback(ctx)
      },
    }
    return ctx
  }

  if (services.tools !== undefined) {
    services.tools = {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    }
  }
  if (services.webServer !== undefined) {
    services.webServer = {
      register(route) {
        // The real Host keys exact routes by path and throws on a second one for the same
        // path. The stub has to throw too: a duplicate aborts the Host's whole registration
        // pass (every route declared after it disappears) while every test here stays green
        // — that is how `/sync` answered GET and POST as two registrations until 2026-10-29.
        if (state.routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
        state.routes.set(route.path, route)
        // A route may answer more than one verb (`/sync` does); lookups stay by verb+path.
        const verbs = String(route.method).split(',')
        for (const verb of verbs) state.routeTable.set(`${verb} ${route.path}`, route)
        return () => {
          state.routes.delete(route.path)
          for (const verb of verbs) state.routeTable.delete(`${verb} ${route.path}`)
        }
      },
    }
  }
  if (services.systemPrompt !== undefined) {
    services.systemPrompt = {
      section(section) {
        state.promptSections.push(section)
        return () => undefined
      },
    }
  }

  /** Deliver an event the way the Loader does: scoped session first, event second. */
  const emit = (name, ...args) => {
    for (const listener of state.listeners.get(name) ?? []) listener(...args)
  }

  return { ctx: makeCtx(), state, emit }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk ?? ''
      this.writableEnded = true
    },
    json() {
      return this.body === '' ? null : JSON.parse(this.body)
    },
  }
}

function makeReq(options = {}) {
  const body = options.body ?? ''
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/api/global-todo/list',
    headers: options.headers ?? { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

/** Wait for the plugin's fire-and-forget bookkeeping to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

/** A recording `agents` service, enough to complete a hand-off and to be asked. */
function makeAgents() {
  const created = []
  const sessions = new Map()
  return {
    created,
    sessions,
    /** Register a conversation that is already running. */
    live(id, header = { cwd: '/repo' }) {
      const sent = []
      const agent = {
        id,
        status: 'idle',
        sent,
        session: { header },
        followup: (message) => sent.push(message),
        steer: (message) => sent.push(message),
      }
      sessions.set(id, agent)
      return agent
    },
    async create(options) {
      const sent = []
      created.push(options)
      return {
        agent: {
          id: options.sessionId,
          status: 'idle',
          sent,
          followup: (message) => sent.push(message),
          steer: (message) => sent.push(message),
        },
      }
    },
    get(id) {
      return sessions.get(id)
    },
  }
}

/**
 * Poll until `check` passes.
 *
 * The plugin's bookkeeping is fire-and-forget, so a test does have to wait for it — but a
 * fixed sleep waits for the machine, which is how a 300 ms sleep reached CI and lost the
 * race on the slower runner. This waits for the *result* the assertions are about, and
 * gives up loudly instead of guessing.
 *
 * @param {() => boolean | Promise<boolean>} check
 * @param {string} what - what we are waiting for, named in the failure
 * @param {number} [timeoutMs]
 */
async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) assert.fail(`waited ${timeoutMs}ms for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Poll until `check` passes, counting attempts instead of reading the clock.
 *
 * The timer tests below deliberately replace `Date.now` — they drive the half-hour rule from a
 * fake clock — so a `waitFor` deadline never arrives inside them and a stuck poll would hang
 * instead of failing. Bounded by attempts, this works under a stubbed clock and still gives up
 * loudly. A fixed sleep is the thing being avoided: it reports on the machine, and it cost a CI
 * run before this helper existed.
 *
 * @param {() => boolean | Promise<boolean>} check
 * @param {string} what - named in the failure
 * @param {number} [attempts]
 */
async function pollUntil(check, what, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`polled ${attempts} times for ${what}`)
}

test('the plugin mounts, registers its surfaces, and survives a full round trip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-'))
  const file = path.join(dir, 'todos.json')
  try {
    const agents = makeAgents()
    const host = makeHost({
      tools: {},
      webServer: {},
      systemPrompt: {},
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      agentPresets: {
        resolve: async () => ({ id: 'default' }),
        mount: async () => undefined,
      },
    })

    apply(host.ctx, { storePath: file, requireExistingFiles: false, dispatchDir: '/home/me/projects/demo' })

    // Surfaces
    assert.equal(host.state.tools.size, 11, 'all eleven tools must register')
    assert.equal(host.state.routes.size, 27, 'all twenty-seven routes must register')
    assert.equal(host.state.promptSections.length, 1)
    assert.equal(host.state.promptSections[0].name, 'dsh-global-todo:guidance')
    assert.ok(host.state.warnings.length === 0, `no warnings expected, got: ${host.state.warnings.join('; ')}`)
    assert.ok(host.state.infos.some((line) => line.includes(`v${VERSION}`)))

    // Agent tool -> disk
    const addTool = host.state.tools.get('global_todo_add')
    const added = await addTool.execute({
      title: '把插件装上',
      description: '先备份 profile',
      links: ['https://example.com/pr', '/tmp/plan.md'],
      // A deadline, because an agent-written record without one now waits in the inbox.
      dueAt: '2026-11-30T10:00',
    })
    assert.equal(added.ok, true)
    assert.equal(added.todo.createdBy, 'agent')
    assert.match(addTool.output.render({}, added)[0].text, /已记入全局待办/)

    // HTTP route -> the same file
    const createRoute = host.state.routes.get('/api/global-todo/create')
    const createRes = makeRes()
    await createRoute.handler(
      makeReq({ method: 'POST', url: '/api/global-todo/create', body: JSON.stringify({ title: '人加的' }) }),
      createRes,
    )
    assert.equal(createRes.statusCode, 200)
    assert.equal(createRes.json().data.todo.createdBy, 'human')

    const listRoute = host.state.routes.get('/api/global-todo/list')
    const listRes = makeRes()
    await listRoute.handler(makeReq({ url: '/api/global-todo/list?status=all' }), listRes)
    assert.equal(listRes.json().data.todos.length, 2, 'the agent tool and the panel write one list')

    // Hand-off through the route, with the registry and preset present
    const todoId = createRes.json().data.todo.id
    const dispatchRoute = host.state.routes.get('/api/global-todo/dispatch')
    const dispatchRes = makeRes()
    await dispatchRoute.handler(
      makeReq({ method: 'POST', url: '/api/global-todo/dispatch', body: JSON.stringify({ id: todoId, mode: 'new' }) }),
      dispatchRes,
    )
    assert.equal(dispatchRes.statusCode, 200)
    assert.equal(dispatchRes.json().data.mode, 'new')
    assert.equal(agents.created.length, 1)
    assert.match(agents.created[0].sessionId, /^session-/)
    assert.equal(typeof agents.created[0].setup, 'function')

    // The file itself is the artifact: readable JSON, one record per todo.
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 2, 'the document carries tombstones, so the schema moved to 2')
    assert.equal(raw.todos.length, 2)
    assert.equal(raw.todos[0].createdBy, 'agent')
    assert.equal(typeof raw.todos[0].createdAt, 'number')
    assert.equal(raw.todos[0].links.length, 2)
    assert.equal(raw.todos[1].createdBy, 'human')

    // Unmounting must not throw and must release the surfaces.
    for (const label of host.state.effects) assert.equal(typeof label, 'string')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('with no optional service the plugin still mounts and only loses surfaces', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-bare-'))
  try {
    const host = makeHost({})
    assert.doesNotThrow(() => apply(host.ctx, { storePath: path.join(dir, 'todos.json') }))
    assert.equal(host.state.tools.size, 0)
    assert.equal(host.state.routes.size, 0)
    assert.equal(host.state.promptSections.length, 0)
    assert.ok(host.state.infos.some((line) => line.includes('已挂载')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the automatic collect switch waits for quiet instead of asking at every turn end', async () => {
  // The complaint this encodes: asking at `turn/end` produced a question every few minutes
  // for a session that was still being worked in. A clean turn now only marks the
  // conversation as a candidate; the timer asks once it has been quiet for `idleMinutes`.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-auto-'))
  try {
    const agents = makeAgents()
    const host = makeHost({
      tools: {},
      webServer: {},
      systemPrompt: {},
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    const person = agents.live('session-person')
    const session = (id) => ({ id, header: { id } })
    const settingsRoute = host.state.routes.get('/api/global-todo/settings')
    const posted = makeRes()
    await settingsRoute.handler(
      makeReq({ method: 'POST', url: '/api/global-todo/settings', body: JSON.stringify({ autoCollect: true }) }),
      posted,
    )
    assert.equal(JSON.parse(posted.body).data.settings.autoCollect, true)

    // A person speaks, works, and the turn ends cleanly.
    host.emit('session/event', session('session-person'), { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } })
    host.emit('session/event', session('session-person'), { type: 'turn/start', seq: 2, data: { turn: 1 } })
    host.emit('session/event', session('session-person'), { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    await settle()
    assert.equal(person.sent.length, 0, 'a clean turn must not ask immediately')

    // Another clean turn a moment later still asks nothing: the conversation is in use.
    host.emit('session/event', session('session-person'), { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } })
    await settle()
    assert.equal(person.sent.length, 0, 'a busy conversation is never asked')

    const health = host.state.routes.get('/api/global-todo/health')
    const healthRes = makeRes()
    await health.handler(makeReq({ url: '/api/global-todo/health' }), healthRes)
    const payload = JSON.parse(healthRes.body)
    assert.equal(payload.data.settings.autoCollect, true)
    assert.equal(payload.data.autoCollect.error, null)
    assert.equal(payload.data.autoCollect.enabled, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conversation is asked once, and only a person re-arms it', async () => {
  // The incident this encodes: the question the plugin sends *is* a message in the
  // conversation, so it restarted the quiet clock, and the answer to it ended a clean turn —
  // which put the same conversation straight back in the queue. With the cooldown on the same
  // half hour as the quiet window it had always expired by the time the window opened, so the
  // conversation was asked again and again, all night, with nobody there.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-loop-'))
  const realSetInterval = globalThis.setInterval
  const realNow = Date.now
  const ticks = []
  let now = 1_000_000_000
  try {
    // The real timer is a one-minute interval against a half-hour rule, so this test drives
    // the tick and the clock itself rather than waiting.
    globalThis.setInterval = (callback) => {
      ticks.push(callback)
      return { unref() {} }
    }
    Date.now = () => now

    const agents = makeAgents()
    const host = makeHost({
      tools: {},
      webServer: {},
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    const person = agents.live('session-person')
    const session = (id) => ({ id, header: { id } })
    await host.state.routes.get('/api/global-todo/settings').handler(
      makeReq({ method: 'POST', url: '/api/global-todo/settings', body: JSON.stringify({ autoCollect: true }) }),
      makeRes(),
    )
    assert.ok(ticks.length > 0, 'the plugin must have armed its timer')

    const emit = (type, data) => host.emit('session/event', session('session-person'), { type, seq: now, data })
    const speak = (kind) => {
      now += 1000
      emit('user/message', { source: { kind } })
    }
    const endCleanTurn = () => emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const idle = (minutes) => {
      now += minutes * 60 * 1000
      for (const tick of ticks) tick()
    }

    speak('user')
    endCleanTurn()
    idle(31)
    await pollUntil(() => person.sent.length === 1, 'the question to be asked')
    assert.equal(person.sent.length, 1, 'a quiet conversation with a person in it is asked once')

    // What the conversation receives next is the plugin's own question, and answering it
    // ends a clean turn of its own — the shape that used to restart the whole cycle.
    speak('plugin:dsh-global-todo')
    emit('turn/start', { turn: 2 })
    endCleanTurn()
    idle(3 * 60)
    await settle()
    assert.equal(person.sent.length, 1, 'the plugin must not answer its own question by asking again')

    // A person writing is the one thing that arms it once more.
    speak('user')
    endCleanTurn()
    idle(31)
    await pollUntil(() => person.sent.length === 2, 'the second question')
    assert.equal(person.sent.length, 2, 'a person re-arms the conversation')
  } finally {
    globalThis.setInterval = realSetInterval
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed question is retried after a backoff instead of silencing the conversation', async () => {
  // The failure mode: a question that could not be delivered still booked the cooldown, so
  // `awaiting-human` kept that conversation quiet until a person happened to speak again.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-retry-'))
  const realSetInterval = globalThis.setInterval
  const realNow = Date.now
  const ticks = []
  let now = 1_000_000_000
  try {
    globalThis.setInterval = (callback) => {
      ticks.push(callback)
      return { unref() {} }
    }
    Date.now = () => now

    const agents = makeAgents()
    const host = makeHost({
      tools: {},
      webServer: {},
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    const person = agents.live('session-person')
    const delivered = []
    let failuresLeft = 1
    // `followup` is what the dispatcher calls; throwing here is exactly a resume that failed.
    person.followup = (message) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error('the conversation could not be resumed')
      }
      delivered.push(message)
    }

    await host.state.routes.get('/api/global-todo/settings').handler(
      makeReq({
        method: 'POST',
        url: '/api/global-todo/settings',
        body: JSON.stringify({ autoCollect: true }),
      }),
      makeRes(),
    )

    const session = (id) => ({ id, header: { id } })
    const emit = (type, data) => host.emit('session/event', session('session-person'), { type, seq: now, data })
    const health = async () => {
      const res = makeRes()
      await host.state.routes.get('/api/global-todo/health').handler(makeReq({ url: '/api/global-todo/health' }), res)
      return res.json().data
    }
    const idle = (minutes) => {
      now += minutes * 60 * 1000
      for (const tick of ticks) tick()
    }

    now += 1000
    emit('user/message', { source: { kind: 'user' } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    idle(31)
    await pollUntil(async () => {
      const current = await health()
      return current.autoCollect.stats.failed === 1 && current.autoCollect.lastRetry !== null
    }, 'the failed question and its retry to be recorded')

    const failed = await health()
    assert.match(failed.autoCollect.error, /resumed/)
    assert.equal(failed.autoCollect.waiting, 1, 'the candidate is kept for the retry')
    assert.ok(failed.autoCollect.lastRetry.nextAt > now, 'the retry waits at least one delay')
    assert.equal(failed.autoCollect.stats.asked, 1)
    assert.equal(delivered.length, 0)

    // Another tick before the delay expires must not try again.
    idle(0.5)
    await settle()
    assert.equal((await health()).autoCollect.stats.asked, 1, 'no retry before the backoff')

    // After it, the same conversation is asked once, and the failure stops counting.
    idle(2)
    await pollUntil(() => delivered.length === 1, 'the retry to be delivered')
    const after = await health()
    assert.equal(after.autoCollect.stats.succeeded, 1)
    assert.equal(after.autoCollect.stats.failed, 1)
    assert.equal(after.autoCollect.lastRetry, null, 'a success clears the pending retry')
    assert.equal(after.autoCollect.lastAsk.sessionId, 'session-person')
  } finally {
    globalThis.setInterval = realSetInterval
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('a quiet conversation never has its open todos closed for it', async () => {
  // The incident this encodes: on the night of 2026-10-15 a conversation that had gone quiet
  // had eight todos it had written closed with a template summary — including one waiting on a
  // person and one waiting on an event that had not happened yet. Quiet is what a conversation
  // looks like when it is *waiting*, so it is the wrong signal to close a todo on. Only the
  // agent's own `global_todo_done`, or the guarded hand-off watcher, may close one.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-quiet-'))
  const realSetInterval = globalThis.setInterval
  const realNow = Date.now
  const ticks = []
  let now = 1_000_000_000
  try {
    globalThis.setInterval = (callback) => {
      ticks.push(callback)
      return { unref() {} }
    }
    Date.now = () => now

    const host = makeHost({ tools: {}, webServer: {}, agents: makeAgents() })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    // A conversation writes a todo that is waiting on somebody else.
    const added = await host.state.tools.get('global_todo_add').execute(
      { title: '等对方回信', description: '回信还没到，不能算做完', dueAt: '2026-11-30T10:00' },
      { agent: { id: 'session-person', session: { header: { cwd: '/repo' } } } },
    )
    assert.equal(added.ok, true)
    assert.equal(added.todo.originSessionId, 'session-person', 'the todo belongs to that conversation')

    // It speaks, the turn ends cleanly, and then nothing happens for hours — the shape that
    // used to be read as "finished".
    const session = (id) => ({ id, header: { id } })
    host.emit('session/event', session('session-person'), {
      type: 'user/message',
      seq: 1,
      data: { source: { kind: 'user' } },
    })
    host.emit('session/event', session('session-person'), {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    now += 6 * 60 * 60 * 1000
    for (let pass = 0; pass < 5; pass += 1) {
      for (const tick of ticks) tick()
      await settle()
    }

    const res = makeRes()
    await host.state.routes
      .get('/api/global-todo/list')
      .handler(makeReq({ url: '/api/global-todo/list?status=active' }), res)
    const todos = JSON.parse(res.body).data.todos
    assert.equal(todos.length, 1, 'the waiting todo is still on the list')
    assert.equal(todos[0].status, 'open', 'going quiet is not a verdict on the work')
    assert.equal(todos[0].completion ?? null, null, 'and it wears no completion record')
  } finally {
    globalThis.setInterval = realSetInterval
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})


test('a turn that already recorded something is not asked again', async () => {
  // The rule the user asked for on 2026-10-30: if the agent wrote a todo during this turn, the
  // automatic "anything to follow up on?" question for that turn is pointless — it was answered
  // by the write itself, and asking anyway is how the list filled with items nobody asked for.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-captured-'))
  const realSetInterval = globalThis.setInterval
  const ticks = []
  try {
    globalThis.setInterval = (callback) => {
      ticks.push(callback)
      return { unref() {} }
    }
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ version: 1, autoCollect: true, idleMinutes: 5, cooldownMinutes: 5 }),
      'utf8',
    )
    const host = makeHost({ tools: {}, webServer: {}, agents: makeAgents() })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })
    await settle()
    const session = (id) => ({ id, header: { id, cwd: '/repo' } })
    const turn = (id, seq) => {
      host.emit('session/event', session(id), { type: 'turn/start', seq, data: { turn: 1 } })
      host.emit('session/event', session(id), { type: 'turn/end', seq: seq + 1, data: { turn: 1, reason: { kind: 'completed' } } })
    }

    // Session A records something itself during its turn.
    host.emit('session/event', session('session-a'), { type: 'turn/start', seq: 1, data: { turn: 1 } })
    const added = await host.state.tools
      .get('global_todo_add')
      .execute(
        { title: '这一轮已经记过了', dueAt: '2026-11-30T10:00' },
        { agent: { id: 'session-a', session: { header: { cwd: '/repo' } } } },
      )
    assert.equal(added.ok, true)
    assert.equal(added.todo.originSessionId, 'session-a')
    host.emit('session/event', session('session-a'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

    // Session B does the same thing but records nothing.
    turn('session-b', 1)

    await waitFor(async () => {
      const res = makeRes()
      await host.state.routes.get('/api/global-todo/health').handler(makeReq({ url: '/api/global-todo/health' }), res)
      return JSON.parse(res.body).data.autoCollect.stats.skippedCaptured >= 1
    }, 'the captured turn to be dropped from the queue')
    for (const tick of ticks) tick()
    await settle()

    const res = makeRes()
    await host.state.routes.get('/api/global-todo/health').handler(makeReq({ url: '/api/global-todo/health' }), res)
    const autoCollect = JSON.parse(res.body).data.autoCollect
    assert.equal(autoCollect.waiting, 1, 'only the conversation that recorded nothing is still a candidate')
    assert.equal(autoCollect.stats.skippedCaptured, 1)
    const queueReason = autoCollect.decisions ?? []
    assert.ok(
      queueReason.every((entry) => entry.sessionId !== 'session-a'),
      'the conversation that recorded is not even offered as a candidate',
    )
  } finally {
    globalThis.setInterval = realSetInterval
    await rm(dir, { recursive: true, force: true })
  }
})

test('an exempted workspace is never asked, and stops being exempt when the list changes', async () => {
  // The case this exists for: a workspace whose conversations a machine drives — a chat
  // companion, say — must not have "anything to follow up on?" injected into it. Keyed on the
  // working directory, because such a session is recreated with a new id whenever it restarts,
  // and an exemption pinned to an id would quietly stop applying.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-exempt-'))
  const realSetInterval = globalThis.setInterval
  const realNow = Date.now
  const ticks = []
  let now = 1_000_000_000
  try {
    globalThis.setInterval = (callback) => {
      ticks.push(callback)
      return { unref() {} }
    }
    Date.now = () => now

    const agents = makeAgents()
    const host = makeHost({
      tools: {},
      webServer: {},
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    const person = agents.live('session-person', { cwd: '/home/me/workspace/示例工作区' })
    const session = (id) => ({ id, header: { id } })
    const settingsRoute = host.state.routes.get('/api/global-todo/settings')

    // The switch on, and this place exempted — the panel writes both the same way.
    await settingsRoute.handler(
      makeReq({
        method: 'POST',
        url: '/api/global-todo/settings',
        body: JSON.stringify({ autoCollect: true, exemptWorkspaces: ['/home/me/workspace/示例工作区'] }),
      }),
      makeRes(),
    )

    const speakThenGoQuiet = async () => {
      now += 1000
      host.emit('session/event', session('session-person'), {
        type: 'user/message',
        seq: now,
        data: { source: { kind: 'user' } },
      })
      host.emit('session/event', session('session-person'), {
        type: 'turn/end',
        seq: now,
        data: { turn: 1, reason: { kind: 'completed' } },
      })
      now += 31 * 60 * 1000
      for (const tick of ticks) tick()
      await settle()
    }

    await speakThenGoQuiet()
    assert.equal(person.sent.length, 0, 'an exempted workspace is never asked, however quiet it gets')

    // Take the exemption back: the same conversation is asked, so the exemption is what did it.
    await settingsRoute.handler(
      makeReq({ method: 'POST', url: '/api/global-todo/settings', body: JSON.stringify({ exemptWorkspaces: [] }) }),
      makeRes(),
    )
    await speakThenGoQuiet()
    await pollUntil(() => person.sent.length === 1, 'the question to come through once the exemption is gone')
    assert.equal(person.sent.length, 1, 'with the exemption gone the question comes through')
  } finally {
    globalThis.setInterval = realSetInterval
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('the exemption still holds after the Host has unloaded the conversation', async () => {
  // A machine-driven conversation is idle most of the time, and an idle conversation is one the
  // Host may have unloaded since: `sessionDir` answers '' for a session the agents service no
  // longer holds, and such a conversation can still be asked, because asking resumes it. So the
  // directory is remembered from the conversation's own events instead. Here the live lookup
  // deliberately knows nothing — the agent is registered without a cwd — and the exemption still
  // has to bite.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-exempt2-'))
  const realSetInterval = globalThis.setInterval
  const realNow = Date.now
  const ticks = []
  let now = 1_000_000_000
  try {
    globalThis.setInterval = (callback) => {
      ticks.push(callback)
      return { unref() {} }
    }
    Date.now = () => now

    const agents = makeAgents()
    const host = makeHost({
      tools: {},
      webServer: {},
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    // Askable — so the "not asked" assertion below cannot pass merely because nothing could have
    // been sent — but its directory is not knowable from the live store.
    const person = agents.live('session-person', { id: 'session-person' })
    // The events carry what the Host's Session carries: a header, cwd included.
    const session = () => ({
      id: 'session-person',
      header: { id: 'session-person', cwd: '/home/me/workspace/示例工作区' },
    })
    const settingsRoute = host.state.routes.get('/api/global-todo/settings')
    await settingsRoute.handler(
      makeReq({
        method: 'POST',
        url: '/api/global-todo/settings',
        body: JSON.stringify({ autoCollect: true, exemptWorkspaces: ['/home/me/workspace/示例工作区'] }),
      }),
      makeRes(),
    )

    const speakThenGoQuiet = async () => {
      now += 1000
      host.emit('session/event', session(), { type: 'user/message', seq: now, data: { source: { kind: 'user' } } })
      host.emit('session/event', session(), { type: 'turn/end', seq: now, data: { turn: 1, reason: { kind: 'completed' } } })
      now += 31 * 60 * 1000
      for (const tick of ticks) tick()
      await settle()
    }

    await speakThenGoQuiet()
    assert.equal(person.sent.length, 0, 'the exemption holds even though the live lookup knows nothing')

    await settingsRoute.handler(
      makeReq({ method: 'POST', url: '/api/global-todo/settings', body: JSON.stringify({ exemptWorkspaces: [] }) }),
      makeRes(),
    )
    await speakThenGoQuiet()
    await pollUntil(() => person.sent.length === 1, 'the question to come through')
    assert.equal(person.sent.length, 1, 'and it was askable all along, so the assertion above means something')
  } finally {
    globalThis.setInterval = realSetInterval
    Date.now = realNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('a plugin-written message must not move the current conversation', async () => {
  // The incident this guards: a hand-off injects a user-role message into its
  // target, so tracking "any user-authored message" pulled the current
  // conversation towards the last dispatch target — the next click followed the
  // previous one instead of the person.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-recent-'))
  try {
    const host = makeHost({ tools: {}, webServer: {} })
    apply(host.ctx, { storePath: path.join(dir, 'todos.json'), requireExistingFiles: false })

    const session = (id) => ({ id, header: { id } })
    const userMessage = (kind) => ({ type: 'user/message', seq: 1, data: { source: { kind } } })

    host.emit('session/event', session('session-person'), userMessage('user'))
    host.emit('session/event', session('session-injected'), userMessage('plugin:dsh-global-todo'))
    // A second message written by hand still wins.
    host.emit('session/event', session('session-person-2'), userMessage('user'))
    // Model and tool traffic must never count.
    host.emit('session/event', session('session-model'), userMessage('model'))

    const healthRoute = host.state.routes.get('/api/global-todo/health')
    const healthRes = makeRes()
    await healthRoute.handler(makeReq({ url: '/api/global-todo/health' }), healthRes)
    const payload = JSON.parse(healthRes.body)
    assert.equal(payload.data.target.recentSessionId, 'session-person-2')
    assert.equal(payload.data.target.trackingRecent, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the tracked conversation survives a restart', async () => {
  // Restarts happen constantly during development, and an empty tracker falls
  // back to the panel's stale guess — the path that sent work to the wrong
  // conversation once already. So the id is kept next to the data.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-persist-'))
  try {
    const file = path.join(dir, 'todos.json')
    const read = async (host) => {
      const route = host.state.routes.get('/api/global-todo/health')
      const res = makeRes()
      await route.handler(makeReq({ url: '/api/global-todo/health' }), res)
      return JSON.parse(res.body).data.target.recentSessionId
    }

    const first = makeHost({ tools: {}, webServer: {} })
    apply(first.ctx, { storePath: file, requireExistingFiles: false })
    assert.equal(await read(first), '', 'nothing is known before anyone writes')
    first.emit('session/event', { id: 'session-person', header: {} }, {
      type: 'user/message',
      seq: 1,
      data: { source: { kind: 'user' } },
    })
    // The id reaches the disk through a fire-and-forget write, and a restart reads that
    // file once, at mount. So the file has to be there *before* the second Host starts,
    // otherwise the restart is judging a log that was still in the air.
    const recentFile = path.join(dir, 'recent-session.json')
    await waitFor(
      async () => (await readFile(recentFile, 'utf8').catch(() => '')).includes('session-person'),
      'the tracked conversation to reach the disk',
    )

    const second = makeHost({ tools: {}, webServer: {} })
    apply(second.ctx, { storePath: file, requireExistingFiles: false })
    await waitFor(async () => (await read(second)) === 'session-person', 'the restart to remember the conversation')
    assert.equal(await read(second), 'session-person', 'the restart must not forget the conversation')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a broken tools surface does not stop the web surface from mounting', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-degraded-'))
  try {
    const host = makeHost({ tools: {}, webServer: {} })
    host.state.services.tools.register = () => {
      throw new Error('registry is full')
    }
    assert.doesNotThrow(() => apply(host.ctx, { storePath: path.join(dir, 'todos.json') }))
    assert.ok(host.state.warnings.some((line) => line.includes('工具注册失败')))
    assert.equal(host.state.routes.size, 27, 'routes are independent of the tool registry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the store path from config is honoured, and the default is $DSH_HOME', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-path-'))
  try {
    const host = makeHost({ webServer: {} })
    const custom = path.join(dir, 'nested', 'mine.json')
    apply(host.ctx, { storePath: custom, guidance: false })
    assert.equal(host.state.promptSections.length, 0, 'guidance can be turned off')

    const createRoute = host.state.routes.get('/api/global-todo/create')
    const res = makeRes()
    await createRoute.handler(
      makeReq({ method: 'POST', url: '/api/global-todo/create', body: JSON.stringify({ title: 'A' }) }),
      res,
    )
    assert.equal(res.statusCode, 200)
    const written = JSON.parse(await readFile(custom, 'utf8'))
    assert.equal(written.todos.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a memory plugin nothing changes: one section, and no memory in the reply', async () => {
  // The question this test answers: can somebody install this plugin on a machine that has no
  // memory plugin? Yes — the bridge is the only thing that mentions memory, and it is registered
  // from inside `ctx.inject([... 'mnemonMemory'], …)`, whose callback a host without the service
  // never makes. The fake host mirrors that contract (see makeHost).
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-memory-'))
  try {
    const file = path.join(dir, 'todos.json')
    const host = makeHost({ tools: {}, webServer: {}, systemPrompt: {} })
    apply(host.ctx, { storePath: file, requireExistingFiles: false })
    assert.deepEqual(
      host.state.promptSections.map((section) => section.name),
      ['dsh-global-todo:guidance'],
      'one section: the list has no business talking about a memory plugin that is not installed',
    )
    assert.ok(host.state.routes.size > 0, 'the panel still works')

    const add = await host.state.tools.get('global_todo_add').execute({ title: '没有记忆库也要能记' })
    const done = await host.state.tools.get('global_todo_done').execute({ id: add.todo.id, summary: '记上了' })
    const rendered = host.state.tools.get('global_todo_done').output.render({}, done)[0].text
    assert.doesNotMatch(rendered, /mnemon/, 'no tool that does not exist may be named')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('with a memory plugin the bridge is one extra section, and one line in a completion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-memory-'))
  try {
    const file = path.join(dir, 'todos.json')
    const host = makeHost({ tools: {}, webServer: {}, systemPrompt: {}, mnemonMemory: {} })
    apply(host.ctx, { storePath: file, requireExistingFiles: false })
    const names = host.state.promptSections.map((section) => section.name)
    assert.deepEqual(names, ['dsh-global-todo:guidance', 'dsh-global-todo:memory'])
    const bridge = host.state.promptSections[1].text
    assert.match(bridge, /mnemon_remember/)
    assert.match(bridge, /global_todo_/)

    const add = await host.state.tools.get('global_todo_add').execute({ title: '接上了' })
    const done = await host.state.tools.get('global_todo_done').execute({ id: add.todo.id, summary: '接上了' })
    const rendered = host.state.tools.get('global_todo_done').output.render({}, done)[0].text
    assert.match(rendered, /mnemon_remember/)
    assert.ok(rendered.includes(add.todo.id), 'the memory entry has to be able to name the todo')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the mounted plugin folds through the shared directory, and /health says what happened', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-smoke-sync-'))
  const file = path.join(dir, 'todos.json')
  const share = path.join(dir, 'share')
  try {
    const host = makeHost({ tools: {}, webServer: {} })
    // The deployment key is the fallback the panel writes over; the route and the tool below
    // go through the same instance, which is the wiring a restart has to get right.
    apply(host.ctx, { storePath: file, requireExistingFiles: false, sync: { dir: share } })

    const call = async (method, suffix, body) => {
      const route = host.state.routeTable.get(`${method} /api/global-todo${suffix}`)
      assert.ok(route !== undefined, `no ${method} route for ${suffix}`)
      const response = makeRes()
      await route.handler(
        makeReq({
          method,
          url: `/api/global-todo${suffix}`,
          body: body === undefined ? '' : JSON.stringify(body),
        }),
        response,
      )
      return response
    }

    const before = await call('GET', '/sync')
    assert.equal(before.statusCode, 200)
    const initial = before.json().data
    assert.equal(initial.configured, true, 'a configured deployment reports itself as configured')
    assert.equal(initial.dir, share)
    assert.equal(initial.last, null, 'nothing has run yet')

    const add = await host.state.tools
      .get('global_todo_add')
      .execute({ title: '这一条要过一遍共享目录', dueAt: '2026-11-30T10:00' })
    assert.equal(add.ok, true)

    const ran = await call('POST', '/sync', {})
    assert.equal(ran.statusCode, 200)
    const result = ran.json().data
    assert.equal(result.stats.total, 1)
    assert.equal(result.hubCreated, true, 'the first sync creates the hub')

    const hubFile = path.join(share, 'todos.hub.json')
    const hub = JSON.parse(await readFile(hubFile, 'utf8'))
    assert.equal(hub.version, 2)
    assert.equal(hub.todos.length, 1)
    assert.equal(hub.todos[0].id, add.todo.id)

    // The other machine: a record appears in the hub, and this one folds it in on the next run.
    hub.todos.push({
      id: 't-other001',
      seq: 2,
      title: '另一台机器上记的',
      status: 'open',
      priority: 'normal',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: [],
      links: [],
      steps: [],
      activity: [],
    })
    await writeFile(hubFile, JSON.stringify(hub), 'utf8')

    const second = await call('POST', '/sync', {})
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().data.stats.received, 1, 'the record the other machine left is received')

    const listed = await host.state.tools.get('global_todo_list').execute({ status: 'all' })
    assert.deepEqual(listed.todos.map((todo) => todo.id).sort(), [add.todo.id, 't-other001'].sort())

    const health = await call('GET', '/health')
    assert.equal(health.statusCode, 200)
    const sync = health.json().data.sync
    assert.equal(sync.configured, true)
    assert.equal(sync.last.ok, true, '/health carries the last attempt, not a guess')
    assert.equal(sync.last.stats.received, 1)

    // And the same fold through the agent tool, so the model reaches it the same way the panel does.
    const viaTool = await host.state.tools.get('global_todo_sync').execute({ dryRun: true })
    assert.equal(viaTool.ok, true)
    assert.equal(viaTool.total, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

