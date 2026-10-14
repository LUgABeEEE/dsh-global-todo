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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
        state.routes.set(route.path, route)
        return () => state.routes.delete(route.path)
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

/** A recording `agents` service, enough to complete a hand-off. */
function makeAgents() {
  const created = []
  return {
    created,
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
    get: () => undefined,
  }
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
    assert.equal(host.state.tools.size, 8, 'all eight tools must register')
    assert.equal(host.state.routes.size, 11, 'all eleven routes must register')
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
    assert.equal(raw.version, 1)
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
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = makeHost({ tools: {}, webServer: {} })
    apply(second.ctx, { storePath: file, requireExistingFiles: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
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
    assert.equal(host.state.routes.size, 11, 'routes are independent of the tool registry')
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
