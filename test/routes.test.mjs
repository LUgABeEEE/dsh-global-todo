import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { ROUTE_BASE, createRoutes, isLoopbackRequest, statusForCode } from '../lib/routes.js'

/** @returns {object} a response double that records what was written */
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

/**
 * @param {{ method?: string, url?: string, body?: string, headers?: object, address?: string }} [options]
 */
function makeReq(options = {}) {
  const body = options.body ?? ''
  return {
    method: options.method ?? 'GET',
    url: options.url ?? ROUTE_BASE,
    headers: options.headers ?? { host: '127.0.0.1:3080' },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

async function harness(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-routes-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false } })
  const dispatched = []
  const dispatcher = {
    modes: ['auto', 'bound', 'new', 'current'],
    capabilities: () => ({ agents: true, agentPresets: true, agentDefaultModel: true, workspaceRegistry: true }),
    sessionAlive: (sessionId) => sessionId === 'session-live',
    sessionDir: (sessionId) => (sessionId === 'session-live' ? '/home/me/projects/live' : ''),
    dispatch: async (id, request) => {
      dispatched.push({ id, request })
      return { todo: await service.get(id), mode: request.mode ?? 'auto', sessionId: 'session-fake', reused: false }
    },
    requestCapture: async (request) => {
      if (request?.sessionId === undefined || request.sessionId === '') {
        const error = new Error('找不到「当前对话」')
        error.code = 'dispatch-failed'
        throw error
      }
      return { sessionId: request.sessionId, requested: true }
    },
  }
  const routes = createRoutes({
    service,
    dispatcher,
    version: '0.1.0-test',
    ...(options.completion === undefined ? {} : { completion: options.completion }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.rootCtx === undefined ? {} : { rootCtx: options.rootCtx }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  const call = async (suffix, request) => {
    const route = routes.find((candidate) => candidate.path === `${ROUTE_BASE}${suffix}`)
    assert.ok(route !== undefined, `no route for ${suffix}`)
    const response = makeRes()
    await route.handler(request, response)
    return response
  }
  return { dir, service, routes, call, dispatched, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('the route surface is exactly the documented one', async () => {
  const env = await harness()
  try {
    assert.deepEqual(
      env.routes.map((route) => route.path.replace(`${ROUTE_BASE}/`, '')).sort(),
      [
        'assign',
        'capture',
        'create',
        'diagnostics',
        'dirs',
        'dispatch',
        'get',
        'health',
        'link',
        'list',
        'note',
        'remove',
        'restore',
        'settings',
        'status',
        'update',
      ],
    )
    for (const route of env.routes) assert.equal(route.kind, 'exact')
  } finally {
    await env.cleanup()
  }
})

test('create then list round-trips through HTTP', async () => {
  const env = await harness()
  try {
    const created = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: '写成 HTTP', links: ['https://example.com/a'] }) }))
    assert.equal(created.statusCode, 200)
    const payload = created.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.data.todo.title, '写成 HTTP')
    assert.equal(payload.data.todo.createdBy, 'human')

    const listed = await env.call('/list', makeReq({ url: `${ROUTE_BASE}/list?status=active` }))
    assert.equal(listed.json().data.todos.length, 1)
    assert.equal(listed.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(listed.headers['cache-control'], 'no-store')
  } finally {
    await env.cleanup()
  }
})

test('a rejected value maps to 400 with its machine reason', async () => {
  const env = await harness()
  try {
    const response = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: '' }) }))
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().reason, 'invalid-title')
  } finally {
    await env.cleanup()
  }
})

test('an unknown id maps to 404', async () => {
  const env = await harness()
  try {
    const response = await env.call('/status', makeReq({ method: 'POST', url: `${ROUTE_BASE}/status`, body: JSON.stringify({ id: 't-nope', status: 'done' }) }))
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().reason, 'not-found')
  } finally {
    await env.cleanup()
  }
})

test('a malformed body maps to 400, an oversized body to 413', async () => {
  const env = await harness()
  try {
    const malformed = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: '{oops' }))
    assert.equal(malformed.statusCode, 400)
    assert.equal(malformed.json().reason, 'invalid-json')

    const arrayBody = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: '[1,2,3]' }))
    assert.equal(arrayBody.statusCode, 400)
    assert.equal(arrayBody.json().reason, 'invalid-json')

    const huge = `{"title":"${'x'.repeat(1024 * 1024 + 16)}"}`
    const oversized = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: huge }))
    assert.equal(oversized.statusCode, 413)
  } finally {
    await env.cleanup()
  }
})

test('the wrong verb gets 405 with an Allow header', async () => {
  const env = await harness()
  try {
    const response = await env.call('/create', makeReq({ method: 'GET', url: `${ROUTE_BASE}/create` }))
    assert.equal(response.statusCode, 405)
    assert.equal(response.headers.allow, 'POST')
  } finally {
    await env.cleanup()
  }
})

test('a remote address is refused when the connection fence is absent', async () => {
  const env = await harness()
  try {
    const response = await env.call('/list', makeReq({ url: `${ROUTE_BASE}/list`, address: '192.168.1.50', headers: { host: '192.168.1.50:3080' } }))
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().reason, 'forbidden')
  } finally {
    await env.cleanup()
  }
})

test('the host connection fence wins whenever it is present', async () => {
  const seen = []
  const env = await harness({
    connection: {
      requestRejection(request) {
        seen.push(request.url)
        return request.headers['x-test-reject'] === '1' ? 403 : undefined
      },
    },
  })
  try {
    const rejected = await env.call('/list', makeReq({ url: `${ROUTE_BASE}/list`, headers: { host: 'evil.example', 'x-test-reject': '1' } }))
    assert.equal(rejected.statusCode, 403)
    const allowed = await env.call('/list', makeReq({ url: `${ROUTE_BASE}/list`, headers: { host: 'evil.example' }, address: '10.0.0.9' }))
    assert.equal(allowed.statusCode, 200, 'the fence, not our loopback guess, decides when it is installed')
    assert.equal(seen.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('a fence that registers after mount is still found, so a trusted LAN address works', async () => {
  // The incident this pins: the fence was captured once at mount time, when the
  // service did not exist yet, so every request fell through to the plugin's own
  // loopback check. That check is stricter than the Host's trusted-host list, so a
  // browser anywhere but the Host machine got 403 「只接受本机请求」 on every call —
  // panel, picker and both capture actions alike — while curl from the Host looked
  // fine.
  let fence
  const rootCtx = { get: (name) => (name === 'connection' ? fence : undefined) }
  const env = await harness({ rootCtx })
  const lanRequest = () =>
    makeReq({ url: `${ROUTE_BASE}/list`, address: '192.168.1.50', headers: { host: '192.168.1.10:3080' } })
  try {
    const withoutFence = await env.call('/list', lanRequest())
    assert.equal(withoutFence.statusCode, 403, 'with no fence at all the loopback check still refuses')
    const healthBefore = await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))
    assert.equal(healthBefore.json().data.fence.loopbackFallback, true, 'health must admit which fence is in force')

    // The Host's connection service appears later in the boot order.
    fence = { requestRejection: () => undefined }
    const withFence = await env.call('/list', lanRequest())
    assert.equal(withFence.statusCode, 200, 'a later-registered fence must be used')
    const healthAfter = await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))
    assert.equal(healthAfter.json().data.fence.host, true)
    assert.equal(healthAfter.json().data.fence.loopbackFallback, false)

    // And its verdict is what counts, including a refusal.
    fence = { requestRejection: () => 401 }
    const refused = await env.call('/list', lanRequest())
    assert.equal(refused.statusCode, 401, 'the fence verdict is honoured verbatim')
  } finally {
    await env.cleanup()
  }
})

test('the fence judges browsers while a local script is admitted by the loopback rule', async () => {
  // Both halves matter. The fence authenticates browsers against this process's
  // token, so a browser must go through it — including a stale one, which is a 401
  // the user can fix by reopening the authenticated URL. A credential-less local
  // process (a script on the Host, `curl`, an agent) is not a browser and cannot be
  // a cross-site actor, so it is judged by the loopback rule; without that carve-out
  // the fence locks out the Host's own tooling.
  const env = await harness({ connection: { requestRejection: () => 401 } })
  const local = (headers) => makeReq({ url: `${ROUTE_BASE}/list`, address: '127.0.0.1', headers })
  try {
    const script = await env.call('/list', local({ host: '127.0.0.1:3080' }))
    assert.equal(script.statusCode, 200, 'a local script must not need a browser token')

    const withCookie = await env.call('/list', local({ host: '127.0.0.1:3080', cookie: 'dsh=stale' }))
    assert.equal(withCookie.statusCode, 401, 'a browser goes through the fence')

    const withOrigin = await env.call('/list', local({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))
    assert.equal(withOrigin.statusCode, 401, 'an Origin means a browser too')

    const crossSite = await env.call(
      '/list',
      local({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }),
    )
    // Refused with the fence's own verdict (401 here), not rescued by the carve-out:
    // `isLoopbackRequest` treats a cross-site request as non-local by definition.
    assert.equal(crossSite.statusCode, 401, 'cross-site never counts as local')

    const remote = await env.call(
      '/list',
      makeReq({ url: `${ROUTE_BASE}/list`, address: '192.168.1.50', headers: { host: '192.168.1.10:3080' } }),
    )
    assert.equal(remote.statusCode, 401, 'a remote caller with no browser credentials is still fenced')
  } finally {
    await env.cleanup()
  }
})

test('a fence that throws fails closed', async () => {
  const env = await harness({
    connection: {
      requestRejection() {
        throw new Error('boom')
      },
    },
    logger: { warn() {} },
  })
  try {
    const response = await env.call('/list', makeReq({ url: `${ROUTE_BASE}/list` }))
    assert.equal(response.statusCode, 403)
  } finally {
    await env.cleanup()
  }
})

test('link accepts additions and removals in one call', async () => {
  const env = await harness()
  try {
    const created = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: 'A' }) }))
    const id = created.json().data.todo.id
    const linked = await env.call(
      '/link',
      makeReq({ method: 'POST', url: `${ROUTE_BASE}/link`, body: JSON.stringify({ id, add: ['https://example.com/1', 'https://example.com/2'] }) }),
    )
    assert.equal(linked.json().data.added, 2)
    const removed = await env.call(
      '/link',
      makeReq({ method: 'POST', url: `${ROUTE_BASE}/link`, body: JSON.stringify({ id, remove: ['https://example.com/1'] }) }),
    )
    assert.equal(removed.json().data.removed, 1)
    assert.equal(removed.json().data.todo.links[0].value, 'https://example.com/2')
  } finally {
    await env.cleanup()
  }
})

test('the dispatch route forwards the mode and records the outcome', async () => {
  const env = await harness()
  try {
    const created = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: '交给 Agent' }) }))
    const id = created.json().data.todo.id
    const response = await env.call('/dispatch', makeReq({ method: 'POST', url: `${ROUTE_BASE}/dispatch`, body: JSON.stringify({ id, mode: 'new' }) }))
    assert.equal(response.statusCode, 200)
    // The whole forwarded shape, so a field added or dropped here is visible.
    assert.deepEqual(env.dispatched, [
      {
        id,
        request: { mode: 'new', sessionId: undefined, dir: undefined, authoritative: false, workspaceId: undefined },
      },
    ])
    assert.equal(response.json().data.sessionId, 'session-fake')
  } finally {
    await env.cleanup()
  }
})

test('the list reply says whether a bound session is still alive', async () => {
  const env = await harness()
  try {
    const live = await env.service.create({ title: '有活会话' })
    const gone = await env.service.create({ title: '会话没了' })
    const never = await env.service.create({ title: '没派发过' })
    await env.service.recordDispatch(live.id, { mode: 'new', ok: true, sessionId: 'session-live' })
    await env.service.recordDispatch(gone.id, { mode: 'new', ok: true, sessionId: 'session-dead' })

    const payload = (await env.call('/list', makeReq({ url: `${ROUTE_BASE}/list?status=all` }))).json()
    const byId = new Map(payload.data.todos.map((todo) => [todo.id, todo]))
    assert.equal(byId.get(live.id).sessionAlive, true)
    assert.equal(byId.get(live.id).sessionDir, '/home/me/projects/live')
    assert.equal(byId.get(gone.id).sessionAlive, false)
    assert.equal(byId.get(gone.id).sessionDir, '')
    assert.equal(byId.get(never.id).sessionAlive, false)
  } finally {
    await env.cleanup()
  }
})

test('restore puts a removed record back through HTTP', async () => {
  const env = await harness()
  try {
    const created = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: 'A' }) }))
    const id = created.json().data.todo.id
    const removed = await env.call('/remove', makeReq({ method: 'POST', url: `${ROUTE_BASE}/remove`, body: JSON.stringify({ id }) }))
    assert.equal(removed.statusCode, 200)
    const record = removed.json().data.todo
    const restored = await env.call('/restore', makeReq({ method: 'POST', url: `${ROUTE_BASE}/restore`, body: JSON.stringify({ todo: record }) }))
    assert.equal(restored.statusCode, 200)
    assert.equal(restored.json().data.todo.id, id)
    const again = await env.call('/restore', makeReq({ method: 'POST', url: `${ROUTE_BASE}/restore`, body: JSON.stringify({ todo: record }) }))
    assert.equal(again.statusCode, 400)
    assert.match(again.json().error, /id 已存在/)
  } finally {
    await env.cleanup()
  }
})

test('health reports the store, the counts and the dispatch capabilities', async () => {
  const env = await harness()
  try {
    await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: 'A' }) }))
    const payload = (await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))).json()
    assert.equal(payload.ok, true)
    assert.equal(payload.data.version, '0.1.0-test')
    assert.equal(payload.data.counts.total, 1)
    assert.match(payload.data.store.file, /todos\.json$/)
    assert.equal(payload.data.dispatch.agents, true)
    assert.equal(payload.data.completion.watching, false, 'no watcher was passed here')
  } finally {
    await env.cleanup()
  }
})

test('health says whether automatic completion is attached', async () => {
  const env = await harness({ completion: { watching: true, error: null } })
  try {
    const payload = (await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))).json()
    assert.equal(payload.data.completion.watching, true)
    assert.equal(payload.data.completion.autoMarksDone, true)
    assert.equal(payload.data.completion.error, null)
  } finally {
    await env.cleanup()
  }
})

test('health reports whether the recent-conversation feed attached', async () => {
  const env = await harness({ target: { id: 'session-recent', watching: true } })
  try {
    const payload = (await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))).json()
    assert.equal(payload.data.target.trackingRecent, true)
    assert.equal(payload.data.target.recentSessionId, 'session-recent')
  } finally {
    await env.cleanup()
  }
})

test('a broken watcher is reported instead of hidden', async () => {
  const env = await harness({ completion: { watching: false, error: 'boom' } })
  try {
    const payload = (await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))).json()
    assert.equal(payload.data.completion.watching, false)
    assert.equal(payload.data.completion.autoMarksDone, false)
    assert.equal(payload.data.completion.error, 'boom')
  } finally {
    await env.cleanup()
  }
})

test('the loopback predicate is strict about address, host and sec-fetch-site', () => {
  assert.equal(isLoopbackRequest(makeReq()), true)
  assert.equal(isLoopbackRequest(makeReq({ address: '::1', headers: { host: 'localhost:3080' } })), true)
  assert.equal(isLoopbackRequest(makeReq({ address: '10.0.0.1' })), false)
  assert.equal(isLoopbackRequest(makeReq({ headers: { host: 'example.com' } })), false)
  assert.equal(isLoopbackRequest(makeReq({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(makeReq({ headers: {} })), false)
})

test('status codes are derived from the machine code table', () => {
  assert.equal(statusForCode('not-found'), 404)
  assert.equal(statusForCode('forbidden'), 403)
  assert.equal(statusForCode('payload-too-large'), 413)
  assert.equal(statusForCode('invalid-link'), 400)
  assert.equal(statusForCode('store-corrupt'), 500)
  assert.equal(statusForCode('agents-unavailable'), 502)
})

test('the directory browser lists folders and refuses what it cannot browse', async () => {
  const env = await harness()
  try {
    const base = env.dir
    await mkdir(path.join(base, 'sub-b'), { recursive: true })
    await mkdir(path.join(base, 'sub-a'), { recursive: true })
    await mkdir(path.join(base, '.hidden'), { recursive: true })
    await writeFile(path.join(base, 'file.txt'), 'x')

    const listed = await env.call('/dirs', makeReq({ url: `${ROUTE_BASE}/dirs?path=${encodeURIComponent(base)}` }))
    assert.equal(listed.statusCode, 200)
    const data = listed.json().data
    assert.deepEqual(data.dirs.map((entry) => entry.name), ['sub-a', 'sub-b'], 'only visible folders, sorted')
    assert.equal(data.parent, path.dirname(base))
    assert.equal(data.dirs[0].path, path.join(base, 'sub-a'))

    const file = await env.call('/dirs', makeReq({ url: `${ROUTE_BASE}/dirs?path=${encodeURIComponent(path.join(base, 'file.txt'))}` }))
    assert.equal(file.statusCode, 404, 'a file is not a folder')

    const relative = await env.call('/dirs', makeReq({ url: `${ROUTE_BASE}/dirs?path=relative/thing` }))
    assert.equal(relative.statusCode, 400, 'a relative path is refused')

    const fallback = await env.call('/dirs', makeReq({ url: `${ROUTE_BASE}/dirs` }))
    assert.equal(fallback.statusCode, 200, 'no path means a sensible root')
    assert.ok(fallback.json().data.path.length > 0)
  } finally {
    await env.cleanup()
  }
})

test('POST /note and /diagnostics reach the service', async () => {
  const recorded = []
  const env = await harness({ diagnostics: { record: (body) => { recorded.push(body); return { at: 1 } }, recent: () => [{ at: 1, scope: 'call', message: 'boom' }] } })
  try {
    const created = await env.call('/create', makeReq({ method: 'POST', url: `${ROUTE_BASE}/create`, body: JSON.stringify({ title: 'A' }) }))
    const id = created.json().data.todo.id
    const noted = await env.call('/note', makeReq({ method: 'POST', url: `${ROUTE_BASE}/note`, body: JSON.stringify({ id, text: '进展一条' }) }))
    assert.equal(noted.statusCode, 200)
    assert.equal(noted.json().data.note.text, '进展一条')

    const reported = await env.call('/diagnostics', makeReq({ method: 'POST', url: `${ROUTE_BASE}/diagnostics`, body: JSON.stringify({ scope: 'capture', status: 502, message: '没在运行' }) }))
    assert.equal(reported.json().data.recorded, true)
    assert.equal(recorded.length, 1)

    const health = await env.call('/health', makeReq({ url: `${ROUTE_BASE}/health` }))
    assert.equal(health.json().data.clientErrors[0].message, 'boom')
  } finally {
    await env.cleanup()
  }
})
