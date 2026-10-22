import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

async function harness(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-tools-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const service = createService({ store, config: { requireExistingFiles: false, ...config } })
  const tools = createTools(service)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const invoke = async (name, args, exec) => {
    const tool = byName.get(name)
    const value = await tool.execute(args, exec)
    return { value, rendered: tool.output.render(args, value) }
  }
  return { dir, store, service, tools, byName, invoke, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('every tool is a complete, self-describing definition', async () => {
  const env = await harness()
  try {
    assert.deepEqual(
      env.tools.map((tool) => tool.name).sort(),
      [
        'global_todo_add',
        'global_todo_capture',
        'global_todo_done',
        'global_todo_get',
        'global_todo_link',
        'global_todo_list',
        'global_todo_note',
        'global_todo_remove',
        'global_todo_reopen',
        'global_todo_update',
      ],
    )
    for (const tool of env.tools) {
      assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`)
      assert.ok(tool.description.length > 20, `${tool.name}'s description must be useful`)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false)
      assert.ok(Array.isArray(tool.parameters.required))
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(typeof tool.isConcurrencySafe(), 'boolean')
    }
  } finally {
    await env.cleanup()
  }
})

test('add records the todo and renders its creation time', async () => {
  const env = await harness()
  try {
    const { value, rendered } = await env.invoke('global_todo_add', {
      title: '写 README',
      description: '中英双语',
      links: ['https://example.com/style', '/tmp/notes.md'],
      tags: ['文档'],
      priority: 'high',
    })
    assert.equal(value.ok, true)
    assert.equal(value.todo.title, '写 README')
    assert.equal(value.todo.createdBy, 'agent')
    assert.equal(value.todo.links.length, 2)
    assert.equal(value.todo.priority, 'high')
    assert.equal(typeof value.todo.createdAt, 'number')
    assert.match(value.todo.createdAtIso, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /已记入全局待办/)
    assert.match(rendered[0].text, /加入于/)
  } finally {
    await env.cleanup()
  }
})

test('a rejected write comes back as a normal tool value, not a throw', async () => {
  const env = await harness()
  try {
    const { value, rendered } = await env.invoke('global_todo_add', { title: '   ' })
    assert.equal(value.ok, false)
    assert.equal(value.reason, 'invalid-title')
    assert.match(rendered[0].text, /没有记录成功/)
  } finally {
    await env.cleanup()
  }
})

test('list defaults to unfinished work and reports the counts', async () => {
  const env = await harness()
  try {
    const first = await env.invoke('global_todo_add', { title: '甲' })
    await env.invoke('global_todo_add', { title: '乙' })
    await env.invoke('global_todo_done', { id: first.value.todo.id })
    const { value, rendered } = await env.invoke('global_todo_list', {})
    assert.equal(value.count, 1)
    assert.equal(value.counts.total, 2)
    assert.equal(value.todos[0].title, '乙')
    assert.match(rendered[0].text, /1 条待办/)
    const all = await env.invoke('global_todo_list', { status: 'all' })
    assert.equal(all.value.count, 2)
    const empty = await env.invoke('global_todo_list', { query: '不存在的东西' })
    assert.equal(empty.value.count, 0)
    assert.match(empty.rendered[0].text, /没有符合条件/)
  } finally {
    await env.cleanup()
  }
})

test('get renders the full record including attachments and dispatch history', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: '带附件', links: ['https://example.com/a'] })
    const { value, rendered } = await env.invoke('global_todo_get', { id: added.value.todo.id })
    assert.equal(value.ok, true)
    assert.match(rendered[0].text, /https:\/\/example\.com\/a/)
    const missing = await env.invoke('global_todo_get', { id: 't-nope' })
    assert.equal(missing.value.ok, false)
    assert.equal(missing.value.reason, 'not-found')
  } finally {
    await env.cleanup()
  }
})

test('update changes only what was asked and reports the field list', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: '原' })
    const id = added.value.todo.id
    const changed = await env.invoke('global_todo_update', { id, title: '新', priority: 'low' })
    assert.deepEqual(changed.value.changed, ['title', 'priority'])
    assert.match(changed.rendered[0].text, /已改：title、priority/)
    const noop = await env.invoke('global_todo_update', { id, title: '新' })
    assert.deepEqual(noop.value.changed, [])
    assert.match(noop.rendered[0].text, /没有字段需要改/)
    const cleared = await env.invoke('global_todo_update', { id, dueAt: '' })
    assert.equal(cleared.value.ok, true)
  } finally {
    await env.cleanup()
  }
})

test('link attaches and detaches documents and addresses', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: 'A' })
    const id = added.value.todo.id
    const linked = await env.invoke('global_todo_link', { id, add: ['https://example.com/x', '/tmp/a.md'] })
    assert.equal(linked.value.added, 2)
    assert.equal(linked.value.todo.links.length, 2)
    assert.match(linked.rendered[0].text, /新增 2 个/)

    const removedByValue = await env.invoke('global_todo_link', { id, remove: ['https://example.com/x'] })
    assert.equal(removedByValue.value.removed, 1)
    assert.equal(removedByValue.value.todo.links.length, 1)

    const removedByIndex = await env.invoke('global_todo_link', { id, remove: [0] })
    assert.equal(removedByIndex.value.removed, 1)
    assert.match(removedByIndex.rendered[0].text, /没有附件/)

    const bad = await env.invoke('global_todo_link', { id, add: ['relative/path.md'] })
    assert.equal(bad.value.ok, false)
    assert.equal(bad.value.reason, 'invalid-link')

    const ignored = await env.invoke('global_todo_link', { id, remove: ['never-had-this'] })
    assert.equal(ignored.value.removed, 0)
  } finally {
    await env.cleanup()
  }
})

test('done, reopen and remove behave as labelled', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: 'A' })
    const id = added.value.todo.id
    const done = await env.invoke('global_todo_done', { id })
    assert.equal(done.value.todo.status, 'done')
    assert.equal(typeof done.value.todo.doneAt, 'number')
    const reopened = await env.invoke('global_todo_done', { id, status: 'open' })
    assert.equal(reopened.value.todo.status, 'open')
    assert.equal(reopened.value.todo.doneAt, null)
    const removed = await env.invoke('global_todo_remove', { id })
    assert.equal(removed.value.ok, true)
    assert.equal((await env.invoke('global_todo_list', { status: 'all' })).value.count, 0)
    const gone = await env.invoke('global_todo_done', { id })
    assert.equal(gone.value.ok, false)
    assert.equal(gone.value.reason, 'not-found')
  } finally {
    await env.cleanup()
  }
})

test('marking done can carry a summary and the artifacts it produced', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: '写文档' })
    const id = added.value.todo.id
    const done = await env.invoke('global_todo_done', {
      id,
      summary: '补了 README 的用法一节，并加了截图',
      artifacts: [
        { kind: 'file', value: '/home/me/projects/dsh-global-todo/README.zh.md', title: 'README.zh.md' },
        { kind: 'url', value: 'https://example.com/pr/1', title: 'PR #1' },
      ],
    })
    assert.equal(done.value.ok, true)
    assert.equal(done.value.todo.status, 'done')
    assert.equal(done.value.todo.completion.summary, '补了 README 的用法一节，并加了截图')
    assert.equal(done.value.todo.completion.artifacts.length, 2)
    assert.equal(done.value.todo.completion.by, 'agent')
    assert.match(done.rendered[0].text, /产出：/)
    assert.match(done.rendered[0].text, /README\.zh\.md/)

    // A plain status change still works and carries no completion record.
    const reopened = await env.invoke('global_todo_done', { id, status: 'open' })
    assert.equal(reopened.value.todo.status, 'open')
    assert.equal(reopened.value.todo.completion, null)
  } finally {
    await env.cleanup()
  }
})

test('reopen is the honest way back from a wrong "done", and records who did it', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: '被误收的一条' })
    const id = added.value.todo.id
    await env.invoke('global_todo_done', { id, summary: '自动收尾：会话安静了' })

    const { value, rendered } = await env.invoke('global_todo_reopen', { id, reason: '误收：这条没做完' })
    assert.equal(value.ok, true)
    assert.equal(value.todo.status, 'open')
    assert.equal(value.todo.doneAt, null)
    assert.equal(value.todo.completion, null, 'a reopened record must not still claim it was finished')
    assert.match(rendered[0].text, /已标回未完成/)

    // The provenance is the point: the trail says an agent reopened it, not a person,
    // and it carries the reason. `presentTodo` hides the trail, so read the record.
    const record = await env.service.get(id)
    assert.equal(record.updatedBy, 'agent')
    const last = record.activity.at(-1)
    assert.equal(last.kind, 'reopened')
    assert.equal(last.by, 'agent')
    assert.match(last.summary, /误收：这条没做完/)

    // Cancelled is the other state this is for.
    await env.service.setStatus(id, 'cancelled')
    const again = await env.invoke('global_todo_reopen', { id })
    assert.equal(again.value.todo.status, 'open')

    // Nothing to reopen: refuse rather than report a fix that did not happen.
    const noop = await env.invoke('global_todo_reopen', { id })
    assert.equal(noop.value.ok, false)
    assert.equal(noop.value.reason, 'invalid-status')
    assert.match(noop.rendered[0].text, /没有标回来/)
  } finally {
    await env.cleanup()
  }
})

test('capture writes a batch and reports the entries it had to skip', async () => {
  const env = await harness()
  try {
    const { value, rendered } = await env.invoke('global_todo_capture', {
      items: [
        { title: '跟一下对方案', description: '等对方回复', links: ['https://example.com/thread'], tags: ['跟进'] },
        { title: '下周交的材料', priority: 'high', dueAt: '2026-11-01' },
        { title: '这个没有标题之外的问题', links: ['relative/path.md'] },
      ],
    })
    assert.equal(value.ok, true)
    assert.equal(value.count, 2, 'the healthy entries must land even when one is rejected')
    assert.equal(value.skipped.length, 1)
    assert.equal(value.skipped[0].title, '这个没有标题之外的问题')
    assert.equal(value.skipped[0].error.length > 0, true)
    assert.equal(value.todos[0].createdBy, 'agent')
    assert.equal(value.todos[0].links.length, 1)
    assert.match(rendered[0].text, /已登记 2 条全局待办/)
    assert.match(rendered[0].text, /跳过 1 条/)
  } finally {
    await env.cleanup()
  }
})

test('capture reports an empty batch instead of pretending', async () => {
  const env = await harness()
  try {
    const empty = await env.invoke('global_todo_capture', { items: [] })
    assert.equal(empty.value.ok, false)
    assert.equal(empty.value.count, 0)
    assert.deepEqual(empty.value.todos, [])
    assert.match(empty.rendered[0].text, /一条都没写进去/)
  } finally {
    await env.cleanup()
  }
})

test('a todo written by a tool remembers which conversation wrote it', async () => {
  const env = await harness()
  try {
    const exec = { agent: { id: 'session-abc', session: { header: { cwd: '/home/me/projects/from-chat' } } } }
    const added = await env.invoke('global_todo_add', { title: '来自会话' }, exec)
    assert.equal(added.value.todo.originDir, '/home/me/projects/from-chat')
    assert.equal(added.value.todo.originSessionId, 'session-abc')

    const batch = await env.invoke('global_todo_capture', { items: [{ title: '批量一' }, { title: '批量二' }] }, exec)
    assert.equal(batch.value.count, 2)
    for (const todo of batch.value.todos) {
      assert.equal(todo.originDir, '/home/me/projects/from-chat')
    }

    // A call without an execution context (an import, a test) must degrade, not throw.
    const bare = await env.invoke('global_todo_add', { title: '没有上下文' })
    assert.equal(bare.value.todo.originDir, '')
    assert.equal(bare.value.todo.originSessionId, '')
  } finally {
    await env.cleanup()
  }
})

test('a progress note is recorded without rewriting the description', async () => {
  const env = await harness()
  try {
    const added = await env.invoke('global_todo_add', { title: 'A', description: '用户写的' })
    const id = added.value.todo.id
    const noted = await env.invoke('global_todo_note', { id, text: '做到一半，卡在需要授权' })
    assert.equal(noted.value.ok, true)
    assert.equal(noted.value.todo.notes.length, 1)
    assert.equal(noted.value.todo.notes[0].text, '做到一半，卡在需要授权')
    assert.equal(noted.value.todo.notes[0].by, 'agent')
    assert.equal(noted.value.todo.description, '用户写的')
    assert.match(noted.rendered[0].text, /已记一条进展/)
  } finally {
    await env.cleanup()
  }
})

test('a document that must exist is refused with a typed reason', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-tools-real-'))
  try {
    const real = path.join(dir, 'real.md')
    await writeFile(real, 'x', 'utf8')
    const store = createStore({ file: path.join(dir, 'todos.json') })
    const service = createService({ store, config: { requireExistingFiles: true } })
    const tools = createTools(service)
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const added = await byName.get('global_todo_add').execute({ title: 'A' })
    const good = await byName.get('global_todo_link').execute({ id: added.todo.id, add: [real] })
    assert.equal(good.ok, true)
    const bad = await byName.get('global_todo_link').execute({ id: added.todo.id, add: [path.join(dir, 'nope.md')] })
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'invalid-link')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a capture run does not register what the list already has', async () => {
  const env = await harness()
  try {
    const first = await env.invoke('global_todo_capture', { items: [{ title: '把 npm 发布跑通' }, { title: '另一个不同的活' }] })
    assert.equal(first.value.count, 2)
    assert.deepEqual(first.value.skipped, [])

    // Same run again: the list has not changed, so nothing new should appear. This is what
    // kept filling the list with near-duplicates on every automatic collect.
    const second = await env.invoke('global_todo_capture', { items: [{ title: '把 npm 发布跑通' }, { title: '新的一件事' }] })
    assert.equal(second.value.count, 1, 'only the genuinely new item is registered')
    assert.equal(second.value.skipped.length, 1)
    assert.match(second.value.skipped[0].error, /已有同名/)
    assert.equal((await env.service.list({ status: 'all' })).todos.length, 3)
  } finally {
    await env.cleanup()
  }
})

test('tool groups shed the collaboration surface without touching the list', async () => {
  const { selectTools, TOOL_GROUPS, normalizeToolGroups } = await import('../lib/tools.js')
  const { createTools } = await import('../lib/tools.js')
  const defs = createTools({ async create() {}, async list() { return { todos: [] } } }, {})
  const names = (mode) => selectTools(defs, mode).map((definition) => definition.name)

  assert.equal(names('all').length, 10)
  assert.deepEqual(names('core'), [...TOOL_GROUPS.core])
  assert.equal(names('none').length, 0)
  // A typo must not quietly remove tools.
  assert.deepEqual(names('coree'), names('all'))
  assert.equal(normalizeToolGroups('nonsense'), 'all')
  // The core set is exactly the list itself: no capture, no attachments, no delete.
  for (const absent of ['global_todo_capture', 'global_todo_link', 'global_todo_remove', 'global_todo_reopen']) {
    assert.equal(names('core').includes(absent), false, absent)
  }
})

test('the guidance section follows the tool groups', async () => {
  const { guidanceFor } = await import('../lib/index.js')
  assert.equal(guidanceFor('none'), '', 'no tools, no instructions')
  assert.match(guidanceFor('all'), /global_todo_capture/)
  assert.doesNotMatch(guidanceFor('core'), /global_todo_capture/, 'do not tell the model to call a tool that is off')
  assert.match(guidanceFor('core'), /global_todo_add/)
})
