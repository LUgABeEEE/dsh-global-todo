import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDispatcher } from '../lib/dispatch.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

/** A recording stand-in for the host's `agents` service. */
function makeAgents() {
  const sessions = new Map()
  const created = []
  return {
    created,
    sessions,
    async create(options) {
      created.push(options)
      const sent = []
      const agent = {
        id: options.sessionId,
        status: 'idle',
        options: options.agentOptions,
        sent,
        followup(message) {
          sent.push({ kind: 'followup', message })
        },
        steer(message) {
          sent.push({ kind: 'steer', message })
        },
      }
      sessions.set(options.sessionId, agent)
      return { agent }
    },
    get(id) {
      return sessions.get(id)
    },
    // The Host loads a persisted session and resumes an agent on it; the double
    // records the call and can be told to fail.
    resumed: [],
    resumeFails: false,
    async resume(options) {
      this.resumed.push(options.resumeSessionId)
      if (this.resumeFails) throw new Error('persistence unavailable')
      const sent = []
      const agent = {
        id: options.resumeSessionId,
        status: 'idle',
        sent,
        session: { header: { cwd: '/resumed' } },
        followup(message) {
          sent.push({ kind: 'followup', message })
        },
        steer(message) {
          sent.push({ kind: 'steer', message })
        },
      }
      sessions.set(options.resumeSessionId, agent)
      return { agent }
    },
  }
}

/**
 * Register a live, message-accepting conversation in the stand-in registry.
 *
 * @param {object} agents - the {@link makeAgents} double
 * @param {string} id
 * @param {{ cwd?: string, status?: string }} [options]
 * @returns {object} the agent row
 */
function liveSession(agents, id, options = {}) {
  const sent = []
  const agent = {
    id,
    status: options.status ?? 'idle',
    session: { header: options.cwd === undefined ? {} : { cwd: options.cwd } },
    sent,
    followup(message) {
      sent.push({ kind: 'followup', message })
    },
    steer(message) {
      sent.push({ kind: 'steer', message })
    },
  }
  agents.sessions.set(id, agent)
  return agent
}

/**
 * @param {{ agents?: object, presets?: object, registry?: object, defaults?: object }} [services]
 */
function makeCtx(services = {}) {
  const table = {
    agents: services.agents,
    agentPresets: services.presets,
    workspaceRegistry: services.registry,
    agentDefaultModel: services.defaults,
  }
  const root = { get: (name) => table[name] }
  return { root, get: root.get }
}

async function harness(config = {}, services = {}, hooks = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-dispatch-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false } })
  const ctx = makeCtx(services)
  // A new session without a working directory is refused, so most tests carry a
  // default one; the tests that care about resolution set their own.
  const resolved = { dispatchDir: path.join(dir, 'default-workspace'), ...config }
  const dispatcher = createDispatcher({
    ctx,
    service,
    config: resolved,
    logger: { warn() {}, info() {} },
    ...(hooks.getRecentSession === undefined ? {} : { getRecentSession: hooks.getRecentSession }),
  })
  return { dir, store, service, dispatcher, config: resolved, services, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('a new-session hand-off mounts the preset, groups the session and sends the todo', async () => {
  const agents = makeAgents()
  const mounted = []
  const attached = []
  const env = await harness(
    { dispatchDir: '/home/me/projects/demo' },
    {
      agents,
      presets: {
        resolve: async (id) => ({ id: id ?? 'default-preset' }),
        mount: async (agentCtx, id) => {
          mounted.push({ agentCtx, id })
        },
      },
      registry: {
        resolveByPath: async () => undefined,
        create: async (dirPath) => {
          attached.push(dirPath)
          return { attachSession: async () => undefined }
        },
      },
      defaults: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    },
  )
  try {
    const todo = await env.service.create({ title: '把插件装上', links: ['https://example.com/pr'] })
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'new' })

    assert.equal(agents.created.length, 1)
    const options = agents.created[0]
    assert.match(options.sessionId, /^session-/)
    assert.equal(options.meta.cwd, '/home/me/projects/demo')
    assert.equal(options.meta.agentPreset, 'default-preset')
    assert.deepEqual(options.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })

    // `setup` is what actually composes the session: without mounting the
    // preset the new agent would have no tools and no prompt.
    assert.equal(typeof options.setup, 'function')
    await options.setup({})
    assert.deepEqual(mounted, [{ agentCtx: {}, id: 'default-preset' }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(attached, ['/home/me/projects/demo'])

    const agent = agents.sessions.get(options.sessionId)
    assert.equal(agent.sent.length, 1)
    const sent = agent.sent[0]
    assert.equal(sent.kind, 'followup')
    // A bare string here corrupts the session record; the content must be blocks.
    assert.ok(Array.isArray(sent.message.content))
    assert.equal(sent.message.content[0].type, 'text')
    assert.match(sent.message.content[0].text, /把插件装上/)
    assert.match(sent.message.content[0].text, /https:\/\/example\.com\/pr/)
    assert.equal(sent.message.role, 'user')
    assert.equal(sent.message.source.kind, 'plugin:dsh-global-todo')

    assert.equal(result.mode, 'new')
    assert.equal(result.reused, false)
    const stored = await env.service.get(todo.id)
    assert.equal(stored.sessionId, options.sessionId)
    assert.equal(stored.lastDispatch.ok, true)
    assert.equal(stored.lastDispatch.mode, 'new')
  } finally {
    await env.cleanup()
  }
})

test('a new session starts in the directory the caller names', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: '点名目录' })
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'new', dir: '/home/me/projects/named' })
    assert.equal(agents.created[0].meta.cwd, '/home/me/projects/named')
    assert.equal(result.dir, '/home/me/projects/named')
    assert.equal((await env.service.get(todo.id)).lastDispatch.dir, '/home/me/projects/named')
  } finally {
    await env.cleanup()
  }
})

test('a new session inherits the directory the todo was written from', async () => {
  const agents = makeAgents()
  const env = await harness({ dispatchDir: '' }, { agents })
  try {
    const todo = await env.service.create(
      { title: '从某个会话里记的' },
      { by: 'agent', origin: { dir: '/home/me/projects/project-a', sessionId: 'session-origin' } },
    )
    assert.equal(todo.originDir, '/home/me/projects/project-a')
    await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    assert.equal(agents.created[0].meta.cwd, '/home/me/projects/project-a')
  } finally {
    await env.cleanup()
  }
})

test('a new session inherits the bound conversation directory when it is still around', async () => {
  const agents = makeAgents()
  const env = await harness({ dispatchDir: '' }, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    await env.dispatcher.dispatch(todo.id, { mode: 'new', dir: '/home/me/projects/first' })
    const bound = agents.sessions.get((await env.service.get(todo.id)).sessionId)
    bound.session = { header: { cwd: '/home/me/projects/first' } }
    // Ask for a *new* session while the bound one still exists: the directory
    // must come from that conversation rather than from nowhere.
    await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    assert.equal(agents.created[1].meta.cwd, '/home/me/projects/first')
  } finally {
    await env.cleanup()
  }
})

test('without any directory the hand-off is refused instead of creating a dead session', async () => {
  const agents = makeAgents()
  const env = await harness({ dispatchDir: '' }, { agents })
  try {
    const todo = await env.service.create({ title: '没有目录' })
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'new' }), (error) => {
      assert.equal(error.code, 'dispatch-failed')
      assert.match(error.message, /工作目录/)
      return true
    })
    assert.equal(agents.created.length, 0, 'no session may be created without a directory')
    const stored = await env.service.get(todo.id)
    assert.equal(stored.lastDispatch.ok, false)
    assert.match(stored.lastDispatch.error, /工作目录/)
  } finally {
    await env.cleanup()
  }
})

test('current hands the work to the conversation the user is in', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/home/me/projects/here' })
    const todo = await env.service.create({ title: '交给你' })
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'current' })
    assert.equal(result.mode, 'current')
    assert.equal(result.sessionId, 'session-here')
    // It went into the existing conversation: no new session was created.
    assert.equal(agents.created.length, 0)
    assert.equal(agents.sessions.get('session-here').sent.length, 1, 'the prompt must land in that conversation')
    assert.match(agents.sessions.get('session-here').sent[0].message.content[0].text, /交给你/)
  } finally {
    await env.cleanup()
  }
})

test('the activity feed outranks the panel\'s guess about the current conversation', async () => {
  // The panel is the main view while it is open, so its idea of "the session on
  // screen" is whatever the view retained earlier — hours stale in practice. The
  // activity feed records a real user message, so it wins.
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/x' })
    liveSession(agents, 'session-stale', { cwd: '/y' })
    const todo = await env.service.create({ title: 'A' })
    const result = await env.dispatcher.dispatch(todo.id, {
      mode: 'current',
      sessionId: 'session-stale',
      // No `authoritative`: the caller is guessing.
    })
    assert.equal(result.sessionId, 'session-here')
    assert.equal(agents.sessions.get('session-here').sent.length, 1)
    assert.equal(agents.sessions.get('session-stale').sent.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('a caller that knows says so and wins', async () => {
  // A button rendered *inside* a conversation knows which one it is.
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/x' })
    liveSession(agents, 'session-named', { cwd: '/y' })
    const todo = await env.service.create({ title: 'A' })
    const result = await env.dispatcher.dispatch(todo.id, {
      mode: 'current',
      sessionId: 'session-named',
      authoritative: true,
    })
    assert.equal(result.sessionId, 'session-named')
  } finally {
    await env.cleanup()
  }
})

test('the reply names the conversation the work went to', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/x' })
    const todo = await env.service.create({ title: 'A' })
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'current' })
    assert.equal(result.target, 'session-here', 'the panel needs the target to say where it went')
  } finally {
    await env.cleanup()
  }
})

test('current falls back to the conversation the todo was written from', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    liveSession(agents, 'session-origin', { cwd: '/origin' })
    const todo = await env.service.create(
      { title: 'A' },
      { by: 'agent', origin: { dir: '/origin', sessionId: 'session-origin' } },
    )
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'current' })
    assert.equal(result.sessionId, 'session-origin')
  } finally {
    await env.cleanup()
  }
})

test('an explicitly picked conversation that is not running is resumed, not substituted', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/here' })
    const todo = await env.service.create({ title: '交给一个没在跑的对话' })
    // The person picked a dormant conversation: it must be woken, not replaced by
    // the session the activity feed happens to name.
    const result = await env.dispatcher.dispatch(todo.id, {
      mode: 'current',
      sessionId: 'session-dormant',
      authoritative: true,
    })
    assert.equal(result.sessionId, 'session-dormant')
    assert.equal(result.resumed, true)
    assert.deepEqual(agents.resumed, ['session-dormant'])
    assert.equal(agents.sessions.get('session-dormant').sent.length, 1)
    assert.equal(agents.sessions.get('session-here').sent.length, 0, 'the other conversation must stay untouched')
  } finally {
    await env.cleanup()
  }
})

test('a picked conversation that cannot be loaded fails instead of going elsewhere', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/here' })
    agents.resumeFails = true
    const todo = await env.service.create({ title: 'A' })
    await assert.rejects(
      () =>
        env.dispatcher.dispatch(todo.id, { mode: 'current', sessionId: 'session-dormant', authoritative: true }),
      (error) => {
        assert.equal(error.code, 'dispatch-failed')
        assert.match(error.message, /没在运行/)
        return true
      },
    )
    assert.equal(agents.sessions.get('session-here').sent.length, 0, 'no silent substitution')
    assert.equal((await env.service.get(todo.id)).lastDispatch.ok, false)
  } finally {
    await env.cleanup()
  }
})

test('current without any resolvable conversation says so instead of guessing', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'current' }), (error) => {
      assert.equal(error.code, 'dispatch-failed')
      assert.match(error.message, /当前对话/)
      return true
    })
    assert.equal(agents.created.length, 0, 'a failed hand-off must not open a session')
    assert.equal((await env.service.get(todo.id)).lastDispatch.ok, false)
  } finally {
    await env.cleanup()
  }
})

test('a dead named session is not a target and the recent one wins', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/here' })
    const todo = await env.service.create({ title: 'A' })
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'current', sessionId: 'session-gone' })
    assert.equal(result.sessionId, 'session-here')
  } finally {
    await env.cleanup()
  }
})

test('auto falls back to the current conversation before opening a new one', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/here' })
    const todo = await env.service.create({ title: 'A' })
    // Never handed over before: auto must not create a session while the user is
    // sitting in a conversation that can do the work.
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'auto' })
    assert.equal(first.mode, 'current')
    assert.equal(first.sessionId, 'session-here')
    assert.equal(agents.created.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('auto still prefers the conversation the todo already owns', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    liveSession(agents, 'session-here', { cwd: '/here' })
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new', dir: '/home/me/projects/owned' })
    agents.sessions.get(first.sessionId).session = { header: { cwd: '/home/me/projects/owned' } }
    const again = await env.dispatcher.dispatch(todo.id, { mode: 'auto' })
    assert.equal(again.mode, 'bound')
    assert.equal(again.sessionId, first.sessionId)
  } finally {
    await env.cleanup()
  }
})

test('capture asks the conversation in front of the user to collect todos', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-here' })
  try {
    const session = liveSession(agents, 'session-here', { cwd: '/home/me/projects/here' })
    const result = await env.dispatcher.requestCapture({})
    assert.equal(result.requested, true)
    assert.equal(result.sessionId, 'session-here')
    assert.equal(session.sent.length, 1, 'the request must land in that conversation')
    const prompt = session.sent[0].message.content[0].text
    assert.match(prompt, /全局待办 · 抓取/)
    assert.match(prompt, /global_todo_capture/)
    assert.match(prompt, /宁可少记/)
    // It is work, not a hand-off of a record: nothing is created or completed.
    assert.equal(agents.created.length, 0)
    assert.equal(env.watcherProbe, undefined)
  } finally {
    await env.cleanup()
  }
})

test('capture refuses when there is no conversation to ask', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    await assert.rejects(() => env.dispatcher.requestCapture({}), (error) => {
      assert.equal(error.code, 'dispatch-failed')
      assert.match(error.message, /当前对话/)
      return true
    })
  } finally {
    await env.cleanup()
  }
})

test('capture follows the same rule: grounded activity first, a knowing caller above it', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents }, { getRecentSession: () => 'session-recent' })
  try {
    const recent = liveSession(agents, 'session-recent', { cwd: '/recent' })
    const named = liveSession(agents, 'session-named', { cwd: '/named' })

    const guessed = await env.dispatcher.requestCapture({ sessionId: 'session-named' })
    assert.equal(guessed.sessionId, 'session-recent')
    assert.equal(recent.sent.length, 1)

    const known = await env.dispatcher.requestCapture({ sessionId: 'session-named', authoritative: true })
    assert.equal(known.sessionId, 'session-named')
    assert.equal(named.sent.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('a new session joins the workspace of the conversation that wrote the todo', async () => {
  const agents = makeAgents()
  const attachments = []
  // The Host exposes `id`; the assertion records it under the name the panel uses.
  const workspaceOf = (workspaceId, path, sessionIds) => ({
    id: workspaceId,
    path,
    title: workspaceId,
    sessionIds,
    attachSession: async (sessionId) => {
      attachments.push({ workspaceId, id: sessionId })
    },
  })
  const origin = workspaceOf('ws-origin', '/ws/origin', ['session-origin'])
  const other = workspaceOf('ws-other', '/ws/other', [])
  const env = await harness(
    {},
    {
      agents,
      registry: {
        list: () => [other, origin],
        get: (id) => [other, origin].find((workspace) => workspace.id === id),
        resolveByPath: async () => undefined,
        create: async () => {
          throw new Error('按目录新建不该被走到：来源会话已经指明了工作区')
        },
      },
    },
  )
  try {
    const todo = await env.service.create(
      { title: 'A' },
      { by: 'agent', origin: { dir: '/ws/origin', sessionId: 'session-origin' } },
    )
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    assert.equal(result.workspace, 'ws-origin', 'the reply names the workspace (id, not workspaceId)')
    assert.equal(result.placed, 'origin')
    assert.equal(agents.created[0].meta.cwd, '/ws/origin', 'cwd follows the owning workspace')
    assert.deepEqual(attachments, [{ workspaceId: 'ws-origin', id: result.sessionId }])
  } finally {
    await env.cleanup()
  }
})

test('a workspace the user names wins over the inherited one', async () => {
  const agents = makeAgents()
  const attachments = []
  // The Host exposes `id`; the assertion records it under the name the panel uses.
  const workspaceOf = (workspaceId, path, sessionIds) => ({
    id: workspaceId,
    path,
    title: workspaceId,
    sessionIds,
    attachSession: async (sessionId) => {
      attachments.push({ workspaceId, id: sessionId })
    },
  })
  const origin = workspaceOf('ws-origin', '/ws/origin', ['session-origin'])
  const chosen = workspaceOf('ws-chosen', '/ws/chosen', [])
  const env = await harness(
    {},
    {
      agents,
      registry: {
        list: () => [origin, chosen],
        get: (id) => [origin, chosen].find((workspace) => workspace.id === id),
        resolveByPath: async () => undefined,
        create: async () => {
          throw new Error('user named a workspace: nothing to create')
        },
      },
    },
  )
  try {
    const todo = await env.service.create(
      { title: 'A' },
      { by: 'agent', origin: { dir: '/ws/origin', sessionId: 'session-origin' } },
    )
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'new', workspaceId: 'ws-chosen' })
    assert.equal(result.workspace, 'ws-chosen')
    assert.equal(result.placed, 'chosen')
    assert.equal(agents.created[0].meta.cwd, '/ws/chosen')
    assert.deepEqual(attachments, [{ workspaceId: 'ws-chosen', id: result.sessionId }])
  } finally {
    await env.cleanup()
  }
})

test('a bound hand-off reuses the same conversation', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: '接着改' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    const second = await env.dispatcher.dispatch(todo.id, { mode: 'bound' })
    assert.equal(agents.created.length, 1, 'bound must not create a second session')
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(second.reused, true)
    const agent = agents.sessions.get(first.sessionId)
    assert.equal(agent.sent.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('auto falls back to a new session once the bound one is gone', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    agents.sessions.delete(first.sessionId)
    const again = await env.dispatcher.dispatch(todo.id, { mode: 'auto' })
    assert.equal(agents.created.length, 2)
    assert.equal(again.mode, 'new')
    assert.notEqual(again.sessionId, first.sessionId)
  } finally {
    await env.cleanup()
  }
})

test('a running session is steered instead of queued', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    agents.sessions.get(first.sessionId).status = 'running'
    await env.dispatcher.dispatch(todo.id, { mode: 'bound' })
    assert.equal(agents.sessions.get(first.sessionId).sent[1].kind, 'steer')
  } finally {
    await env.cleanup()
  }
})

test('auto replaces a live conversation that has no working directory', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new', dir: '/home/me/projects/ok' })
    // The bound session is alive but has no cwd — the state that made hand-offs
    // useless. `auto` must not quietly reuse it.
    agents.sessions.get(first.sessionId).session = { header: {} }
    const again = await env.dispatcher.dispatch(todo.id, { mode: 'auto', dir: '/home/me/projects/ok' })
    assert.equal(again.mode, 'new')
    assert.equal(agents.created.length, 2)
    assert.notEqual(again.sessionId, first.sessionId)
    assert.equal(agents.created[1].meta.cwd, '/home/me/projects/ok')
    // An explicit `bound` still targets what the user asked for.
    await env.dispatcher.dispatch(todo.id, { mode: 'bound', sessionId: again.sessionId })
    assert.equal(agents.created.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('asking for a bound session that no longer exists fails with the reason on the record', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'bound' }), (error) => {
      assert.equal(error.code, 'dispatch-failed')
      assert.match(error.message, /还没有绑定会话/)
      return true
    })
    const stored = await env.service.get(todo.id)
    assert.equal(stored.lastDispatch.ok, false)
    assert.match(stored.lastDispatch.error, /还没有绑定会话/)
    assert.equal(stored.sessionId, '')
  } finally {
    await env.cleanup()
  }
})

test('a stale binding says so and points at auto', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    agents.sessions.delete(first.sessionId)
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'bound' }), /绑定的会话已不在/)
  } finally {
    await env.cleanup()
  }
})

test('a host without the agents service refuses instead of pretending', async () => {
  const env = await harness({}, {})
  try {
    const todo = await env.service.create({ title: 'A' })
    assert.deepEqual(env.dispatcher.capabilities(), {
      agents: false,
      agentPresets: false,
      agentDefaultModel: false,
      workspaceRegistry: false,
    })
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'new' }), (error) => {
      assert.equal(error.code, 'agents-unavailable')
      return true
    })
    const stored = await env.service.get(todo.id)
    assert.equal(stored.lastDispatch.ok, false)
  } finally {
    await env.cleanup()
  }
})

test('a broken preset fails the hand-off loudly', async () => {
  const agents = makeAgents()
  const env = await harness({}, {
    agents,
    presets: {
      resolve: async () => {
        throw new Error('preset 坏了')
      },
      mount: async () => undefined,
    },
  })
  try {
    const todo = await env.service.create({ title: 'A' })
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'new' }), /解析 agent preset 失败/)
    assert.equal(agents.created.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('an unknown mode is rejected before anything is sent', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    await assert.rejects(() => env.dispatcher.dispatch(todo.id, { mode: 'teleport' }), (error) => error.code === 'invalid-body')
    assert.equal(agents.created.length, 0)
    assert.equal((await env.service.get(todo.id)).lastDispatch, null)
  } finally {
    await env.cleanup()
  }
})

test('sessionDir reports where a live conversation would work', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new', dir: '/home/me/projects/here' })
    agents.sessions.get(first.sessionId).session = { header: { cwd: '/home/me/projects/here' } }
    assert.equal(env.dispatcher.sessionDir(first.sessionId), '/home/me/projects/here')
    agents.sessions.get(first.sessionId).session = { header: {} }
    assert.equal(env.dispatcher.sessionDir(first.sessionId), '', 'a session without a cwd reports empty')
    assert.equal(env.dispatcher.sessionDir('session-nope'), '')
  } finally {
    await env.cleanup()
  }
})

test('sessionAlive reports whether the bound session is still there', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    assert.equal(env.dispatcher.sessionAlive(first.sessionId), true)
    assert.equal(env.dispatcher.sessionAlive('session-nope'), false)
    assert.equal(env.dispatcher.sessionAlive(''), false)
    agents.sessions.delete(first.sessionId)
    assert.equal(env.dispatcher.sessionAlive(first.sessionId), false)
  } finally {
    await env.cleanup()
  }
})

test('a host without agents reports every session as gone', async () => {
  const env = await harness({}, {})
  try {
    assert.equal(env.dispatcher.sessionAlive('session-anything'), false)
  } finally {
    await env.cleanup()
  }
})

test('dispatching an unknown todo fails as not-found', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    await assert.rejects(() => env.dispatcher.dispatch('t-nope', { mode: 'new' }), (error) => error.code === 'not-found')
  } finally {
    await env.cleanup()
  }
})

test('the current mode targets an explicit session id', async () => {
  const agents = makeAgents()
  const env = await harness({}, { agents })
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.dispatcher.dispatch(todo.id, { mode: 'new' })
    const result = await env.dispatcher.dispatch(todo.id, { mode: 'current', sessionId: first.sessionId })
    assert.equal(result.reused, true)
    assert.equal(result.sessionId, first.sessionId)
    // An id that cannot be loaded fails clearly: it is never swapped for another
    // conversation.
    agents.resumeFails = true
    await assert.rejects(
      () => env.dispatcher.dispatch(todo.id, { mode: 'current', sessionId: 'session-nope' }),
      (error) => {
        assert.equal(error.code, 'dispatch-failed')
        assert.match(error.message, /没在运行|无法把它加载起来/)
        return true
      },
    )
  } finally {
    await env.cleanup()
  }
})
