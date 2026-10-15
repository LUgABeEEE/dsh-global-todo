import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

/**
 * @param {{ requireExistingFiles?: boolean }} [config]
 */
async function harness(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-service-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false, ...config } })
  return { dir, store, service, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('the human and the agent write through the same validated path', async () => {
  const env = await harness()
  try {
    const byHuman = await env.service.create({ title: '人加的' }, { by: 'human' })
    const byAgent = await env.service.create({ title: 'Agent 加的' }, { by: 'agent' })
    assert.equal(byHuman.createdBy, 'human')
    assert.equal(byAgent.createdBy, 'agent')
    assert.notEqual(byHuman.id, byAgent.id)
    await assert.rejects(() => env.service.create({ title: '' }, { by: 'agent' }), /标题不能为空/)
  } finally {
    await env.cleanup()
  }
})

test('filters cover active, single statuses, overdue and text search', async () => {
  const env = await harness()
  try {
    const open = await env.service.create({ title: '写周报', tags: ['工作'] })
    const doing = await env.service.create({ title: '改 bug' })
    const done = await env.service.create({ title: '买咖啡' })
    const late = await env.service.create({ title: '交材料', dueAt: '2020-01-01' })
    await env.service.setStatus(doing.id, 'doing')
    await env.service.setStatus(done.id, 'done')

    const active = await env.service.list({ status: 'active' })
    assert.deepEqual(
      active.todos.map((todo) => todo.title).sort(),
      ['交材料', '写周报', '改 bug'],
    )
    assert.equal((await env.service.list({ status: 'doing' })).todos.length, 1)
    assert.equal((await env.service.list({ status: 'all' })).todos.length, 4)
    assert.deepEqual((await env.service.list({ status: 'overdue' })).todos.map((todo) => todo.id), [late.id])
    assert.deepEqual((await env.service.list({ status: 'active', query: '周报' })).todos.map((todo) => todo.id), [open.id])
    assert.deepEqual((await env.service.list({ status: 'all', tag: '#工作' })).todos.map((todo) => todo.id), [open.id])
    assert.equal(active.counts.total, 4)
    assert.equal(active.counts.overdue, 1)
    await assert.rejects(() => env.service.list({ status: 'nonsense' }), /筛选条件只能是/)
    await assert.rejects(() => env.service.list({ sort: 'nonsense' }), /排序只能是/)
  } finally {
    await env.cleanup()
  }
})

test('the search box understands tag:, is:, has: and level: tokens', async () => {
  const env = await harness()
  try {
    const tagged = await env.service.create({ title: '写周报', tags: ['工作'], priority: 'urgent' })
    const late = await env.service.create({ title: '交材料', dueAt: '2020-01-01' })
    const attached = await env.service.create({ title: '看规格' })
    await env.service.addLink(attached.id, 'https://example.com/spec')
    const noted = await env.service.create({ title: '追进度' })
    await env.service.note(noted.id, '卡在授权')
    const done = await env.service.create({ title: '买咖啡' })
    await env.service.setStatus(done.id, 'done')

    const ids = async (query) => (await env.service.list({ status: 'all', query })).todos.map((todo) => todo.id)
    assert.deepEqual(await ids('tag:工作'), [tagged.id])
    assert.deepEqual(await ids('#工作'), [tagged.id])
    assert.deepEqual(await ids('level:p0'), [tagged.id], 'p0 is the friendly alias of urgent')
    assert.deepEqual(await ids('is:overdue'), [late.id])
    assert.deepEqual(await ids('has:link'), [attached.id])
    assert.deepEqual(await ids('has:note'), [noted.id])
    assert.deepEqual(await ids('is:done'), [done.id])
    // Free text still has to match every word, alongside the syntax tokens.
    assert.deepEqual(await ids('tag:工作 周报'), [tagged.id])
    assert.deepEqual(await ids('tag:工作 咖啡'), [])
    // A token nobody defined stays a search term rather than becoming a filter.
    assert.deepEqual(await ids('nonsense:thing'), [])
  } finally {
    await env.cleanup()
  }
})

test('sorting by created, updated, due and priority behaves predictably', async () => {
  const env = await harness()
  try {
    const first = await env.service.create({ title: 'first' })
    const second = await env.service.create({ title: 'second', dueAt: '2030-01-01' })
    const third = await env.service.create({ title: 'third', priority: 'high' })
    const ordered = await env.service.list({ status: 'all', sort: 'created' })
    assert.deepEqual(ordered.todos.map((todo) => todo.id), [third.id, second.id, first.id])
    const byDue = await env.service.list({ status: 'all', sort: 'due' })
    assert.equal(byDue.todos[0].id, second.id)
    const byPriority = await env.service.list({ status: 'all', sort: 'priority' })
    assert.equal(byPriority.todos[0].id, third.id)
    await env.service.update(first.id, { title: 'first again' })
    const byUpdated = await env.service.list({ status: 'all', sort: 'updated' })
    assert.equal(byUpdated.todos[0].id, first.id)
  } finally {
    await env.cleanup()
  }
})

test('update reports changed fields, and unknown ids are a typed not-found', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'A' })
    const outcome = await env.service.update(todo.id, { description: '细节', priority: 'high' })
    assert.deepEqual(outcome.changed, ['description', 'priority'])
    assert.equal(outcome.todo.description, '细节')
    await assert.rejects(() => env.service.get('t-missing'), (error) => error.code === 'not-found')
    await assert.rejects(() => env.service.update('t-missing', { title: 'x' }), (error) => error.code === 'not-found')
    await assert.rejects(() => env.service.remove(''), (error) => error.code === 'not-found')
  } finally {
    await env.cleanup()
  }
})

test('attachments can be added, listed and removed, and duplicates are reported', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'A' })
    const first = await env.service.addLink(todo.id, 'https://example.com/spec')
    assert.equal(first.added, true)
    const duplicate = await env.service.addLink(todo.id, 'https://example.com/spec')
    assert.equal(duplicate.added, false)
    const doc = await env.service.addLink(todo.id, { kind: 'file', value: '/tmp/spec.md', title: '规格' })
    assert.equal(doc.todo.links.length, 2)
    const removed = await env.service.removeLink(todo.id, { key: `file\u0000/tmp/spec.md` })
    assert.equal(removed.removed.title, '规格')
    assert.equal(removed.todo.links.length, 1)
    assert.equal((await env.service.removeLink(todo.id, { index: 9 })).removed, null)
  } finally {
    await env.cleanup()
  }
})

test('existing-document checks are enforced when enabled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-links-'))
  try {
    const real = path.join(dir, 'real.md')
    await writeFile(real, '# real', 'utf8')
    const store = createStore({ file: path.join(dir, 'todos.json') })
    const service = createService({ store, config: { requireExistingFiles: true } })
    const todo = await service.create({ title: 'A' })
    const ok = await service.addLink(todo.id, real)
    assert.equal(ok.added, true)
    await assert.rejects(() => service.addLink(todo.id, path.join(dir, 'missing.md')), /找不到这个文件/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('removing a todo deletes only that record', async () => {
  const env = await harness()
  try {
    const keep = await env.service.create({ title: 'keep' })
    const drop = await env.service.create({ title: 'drop' })
    const removed = await env.service.remove(drop.id)
    assert.equal(removed.title, 'drop')
    const rest = await env.service.list({ status: 'all' })
    assert.deepEqual(rest.todos.map((todo) => todo.id), [keep.id])
  } finally {
    await env.cleanup()
  }
})

test('a removed todo can be restored verbatim, but never twice', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '手滑删掉的', description: '别丢', links: ['https://example.com/x'], tags: ['重要'] })
    const createdAt = todo.createdAt
    const removed = await env.service.remove(todo.id)
    assert.equal((await env.service.list({ status: 'all' })).todos.length, 0)

    const restored = await env.service.restore(removed, { by: 'human' })
    assert.equal(restored.id, todo.id)
    assert.equal(restored.createdAt, createdAt, 'the creation time must survive the round trip')
    assert.equal(restored.links.length, 1)
    assert.deepEqual(restored.tags, ['重要'])
    assert.equal(restored.activity.at(-1).kind, 'restored')
    assert.equal((await env.service.list({ status: 'all' })).todos.length, 1)

    await assert.rejects(() => env.service.restore(removed), /id 已存在/)
    await assert.rejects(() => env.service.restore({ title: 'no id' }), (error) => error.code === 'invalid-body')
  } finally {
    await env.cleanup()
  }
})

test('a dispatch result is recorded on the todo, including failures', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: 'A' })
    await env.service.recordDispatch(todo.id, { mode: 'new', ok: true, sessionId: 'session-7' })
    let stored = await env.service.get(todo.id)
    assert.equal(stored.sessionId, 'session-7')
    assert.equal(stored.lastDispatch.ok, true)
    await env.service.recordDispatch(todo.id, { mode: 'auto', ok: false, error: '没有 agents 服务' })
    stored = await env.service.get(todo.id)
    assert.equal(stored.lastDispatch.error, '没有 agents 服务')
    assert.equal(await env.service.recordDispatch('t-missing', { mode: 'auto', ok: false }), null)
  } finally {
    await env.cleanup()
  }
})

test('the dispatch prompt carries the description, the attachments and the creation time', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({
      title: '把插件装上',
      description: '先备份 package.json',
      links: ['https://example.com/pr', { kind: 'file', value: '/tmp/plan.md', title: '方案' }],
      tags: ['发布'],
      dueAt: '2026-11-01',
    })
    const prompt = env.service.dispatchPrompt(await env.service.get(todo.id))
    assert.match(prompt, /把插件装上/)
    assert.match(prompt, /先备份 package.json/)
    assert.match(prompt, /https:\/\/example\.com\/pr/)
    assert.match(prompt, /\/tmp\/plan\.md/)
    assert.match(prompt, /方案/)
    assert.match(prompt, /global_todo_done/)
    assert.match(prompt, /summary/)
    assert.match(prompt, /artifacts/)
    assert.match(prompt, /不要\*\*把它标为完成/)
    assert.match(prompt, new RegExp(todo.id))
    assert.match(prompt, /加入于/)
  } finally {
    await env.cleanup()
  }
})

test('stats and describe report where the data lives', async () => {
  const env = await harness()
  try {
    await env.service.create({ title: 'A' })
    const stats = await env.service.stats()
    assert.equal(stats.total, 1)
    assert.equal(stats.open, 1)
    const described = await env.service.describe()
    assert.equal(described.kind, 'json')
    assert.match(described.file, /todos\.json$/)
    assert.equal(described.todos, 1)
  } finally {
    await env.cleanup()
  }
})

test('the write lock also protects two concurrent service calls', async () => {
  const env = await harness()
  try {
    await Promise.all(Array.from({ length: 15 }, (_value, index) => env.service.create({ title: `并发 ${index}` })))
    const all = await env.service.list({ status: 'all', limit: 100 })
    assert.equal(all.todos.length, 15)
    assert.equal(new Set(all.todos.map((todo) => todo.id)).size, 15)
  } finally {
    await env.cleanup()
  }
})
