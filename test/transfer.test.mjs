import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ROUTE_BASE, createRoutes } from '../lib/routes.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

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
  }
}

/** @param {{ method?: string, url: string, body?: string }} options */
function makeReq(options) {
  const payload = options.body ?? ''
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-transfer-'))
  const file = path.join(dir, 'todos.json')
  const store = createStore({ file })
  const service = createService({ store, config: { requireExistingFiles: false } })
  const dispatcher = { capabilities: () => ({}), sessionAlive: () => false, sessionDir: () => '' }
  const routes = createRoutes({ service, dispatcher, version: '0.1.0-test' })
  const call = async (suffix, request) => {
    const route = routes.find((candidate) => candidate.path === ROUTE_BASE + suffix)
    assert.ok(route !== undefined, 'no route for ' + suffix)
    const response = makeRes()
    await route.handler(request, response)
    return { status: response.statusCode, payload: response.body === '' ? null : JSON.parse(response.body) }
  }
  const exported = async () => (await call('/export', makeReq({ url: ROUTE_BASE + '/export' }))).payload.data.doc
  return { dir, file, service, call, exported, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('an export imported back reproduces the list exactly', async () => {
  const env = await harness()
  try {
    const first = await env.service.create({
      title: '把 dsh-global-todo 发到 npm',
      description: '先对齐版本号，再跑一遍 verify。',
      links: ['https://docs.npmjs.com/trusted-publishers', '/home/me/projects/dsh-global-todo/docs/DESIGN.md'],
      tags: ['发布', '文档'],
      priority: 'high',
      dueAt: '2026-11-01T10:00',
    })
    const second = await env.service.create({ title: '重测内网吞吐' })
    await env.service.note(first.id, '版本号已对齐')
    await env.service.recordDispatch(second.id, { mode: 'new', ok: true, sessionId: 'session-1' })
    await env.service.complete(second.id, { summary: '换了周报模板', artifacts: ['/home/me/notes/周报.md'] })

    const exported = await env.call('/export', makeReq({ url: ROUTE_BASE + '/export' }))
    assert.equal(exported.status, 200)
    assert.equal(exported.payload.data.count, 2)
    const doc = exported.payload.data.doc
    assert.equal(doc.todos.length, 2)

    const imported = await env.call(
      '/import',
      makeReq({ method: 'POST', url: ROUTE_BASE + '/import', body: JSON.stringify({ doc, mode: 'replace' }) }),
    )
    assert.equal(imported.status, 200)
    assert.equal(imported.payload.data.imported, 2)
    assert.equal(imported.payload.data.mode, 'replace')

    assert.deepEqual(await env.exported(), doc, 'export -> import -> export must not change the document')
    // The same document is what landed on disk, not a re-created copy.
    const onDisk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.deepEqual(onDisk.todos, doc.todos)
  } finally {
    await env.cleanup()
  }
})

test('merge keeps this list\'s newer edits, and an older copy cannot undo a deletion', async () => {
  const env = await harness()
  try {
    const a = await env.service.create({ title: 'A 原样' })
    const b = await env.service.create({ title: 'B' })
    const doc = await env.exported()
    // Distinct milliseconds: the fold decides by `updatedAt`, and a test that runs inside one
    // tick would be asserting the tie-break instead of the rule it means to state.
    await new Promise((resolve) => setTimeout(resolve, 5))

    await env.service.update(a.id, { title: 'A 改过' })
    await env.service.remove(b.id)
    const c = await env.service.create({ title: 'C' })

    const merged = await env.call(
      '/import',
      makeReq({ method: 'POST', url: ROUTE_BASE + '/import', body: JSON.stringify({ doc, mode: 'merge' }) }),
    )
    assert.equal(merged.status, 200)
    assert.equal(merged.payload.data.mode, 'merge')
    assert.equal(merged.payload.data.imported, 2)
    // The imported copy is older than this list's edit of A and older than B's deletion, so
    // neither of its two records comes back. Before 0.21.0 the merge replaced by id and the
    // deleted B was appended again — the same resurrect a second machine caused.
    assert.equal(merged.payload.data.total, 2)
    // The fold did try to bring B back and the local tombstone refused it; that is exactly the
    // count worth reporting, even though the list ended up unchanged in size.
    assert.equal(merged.payload.data.removed, 1)

    const after = await env.exported()
    assert.deepEqual(
      after.todos.map((todo) => todo.id),
      [a.id, c.id],
      'the newer local edit wins and the deleted record stays deleted',
    )
    assert.equal(after.todos[0].title, 'A 改过')
    assert.deepEqual(
      after.trash.map((entry) => entry.id),
      [b.id],
      'the deletion travels with the document, so the next copy cannot revive it',
    )
  } finally {
    await env.cleanup()
  }
})

test('a document that cannot be read is refused whole', async () => {
  const env = await harness()
  try {
    await env.service.create({ title: 'A' })
    const before = await env.exported()

    const noId = await env.call(
      '/import',
      makeReq({ method: 'POST', url: ROUTE_BASE + '/import', body: JSON.stringify({ todos: [{ title: '没有 id' }] }) }),
    )
    assert.equal(noId.status, 400)
    assert.match(noId.payload.error, /第 1 条/)

    const duplicate = await env.call(
      '/import',
      makeReq({
        method: 'POST',
        url: ROUTE_BASE + '/import',
        body: JSON.stringify({ todos: [{ ...before.todos[0] }, { ...before.todos[0] }] }),
      }),
    )
    assert.equal(duplicate.status, 400)
    assert.match(duplicate.payload.error, /重复/)

    const empty = await env.call(
      '/import',
      makeReq({ method: 'POST', url: ROUTE_BASE + '/import', body: JSON.stringify({}) }),
    )
    assert.equal(empty.status, 400)
    assert.match(empty.payload.error, /没有待办/)

    assert.deepEqual(await env.exported(), before, 'a refused import must not touch the list')
  } finally {
    await env.cleanup()
  }
})

test('an export carries the stored document, not the runtime annotations', async () => {
  const env = await harness()
  try {
    await env.service.create({ title: '挂一个不存在的文档', links: ['/definitely/not/here.md'] })
    const listed = await env.call('/list', makeReq({ url: ROUTE_BASE + '/list?status=all' }))
    assert.equal(listed.payload.data.todos[0].links[0].missing, true, 'the list marks a dead attachment')

    const doc = await env.exported()
    assert.equal('missing' in doc.todos[0].links[0], false, 'an export has to be importable as it is')
  } finally {
    await env.cleanup()
  }
})

test('the export route refuses a write and the import route refuses a read', async () => {
  const env = await harness()
  try {
    const getAsPost = await env.call('/export', makeReq({ method: 'POST', url: ROUTE_BASE + '/export' }))
    assert.equal(getAsPost.status, 405)
    const postAsGet = await env.call('/import', makeReq({ url: ROUTE_BASE + '/import' }))
    assert.equal(postAsGet.status, 405)
  } finally {
    await env.cleanup()
  }
})
