import test from 'node:test'
import assert from 'node:assert/strict'

import { createTodo } from '../lib/model.js'
import { createTools } from '../lib/tools.js'

/** Minimal service double: the capture tool only creates and reads. */
function fakeService() {
  const created = []
  return {
    created,
    async list() {
      return { todos: [], counts: {}, matched: 0, truncated: false }
    },
    async create(input) {
      const todo = createTodo({ title: '占位' })
      const merged = { ...todo, ...input, id: todo.id, seq: created.length + 1, activity: todo.activity }
      created.push(merged)
      return merged
    },
  }
}

async function run(threshold, items) {
  const service = fakeService()
  const settings = { get: () => ({ captureMinWeight: threshold }) }
  const definitions = createTools(service, { settings })
  const tool = definitions.find((definition) => definition.name === 'global_todo_capture')
  assert.ok(tool !== undefined)
  const value = await tool.execute({ items }, {})
  return { value, service }
}

test('a candidate below the threshold is reported with its weight instead of being registered', async () => {
  const { value, service } = await run(0.35, [
    { title: '记得下周把周报模板换成四段式，周五前发我', description: '字段清单', dueAt: '2026-10-31T18:00' },
    { title: '可能要看看那个日志' },
  ])
  assert.equal(value.count, 1)
  assert.equal(service.created.length, 1)
  assert.equal(value.skipped.length, 1)
  assert.match(value.skipped[0].error, /权重/)
  assert.match(value.skipped[0].error, /低于阈值/)
  assert.match(value.skipped[0].error, /犹豫语/)
})

test('a low threshold lets everything through and a high one blocks a real errand', async () => {
  const permissive = await run(0, [{ title: '可能要看看那个日志' }])
  assert.equal(permissive.value.count, 1)

  const strict = await run(0.95, [{ title: '记得发我', dueAt: '2026-11-01' }])
  assert.equal(strict.value.count, 0)
  assert.match(strict.value.skipped[0].error, /阈值 0.95/)
})

test('the threshold is read per call, so a settings change applies without remounting', async () => {
  let threshold = 0
  const service = fakeService()
  const definitions = createTools(service, { settings: { get: () => ({ captureMinWeight: threshold }) } })
  const tool = definitions.find((definition) => definition.name === 'global_todo_capture')
  const item = { title: '可能要看看那个日志' }

  const first = await tool.execute({ items: [item] }, {})
  assert.equal(first.count, 1)

  threshold = 0.9
  const second = await tool.execute({ items: [item] }, {})
  assert.equal(second.count, 0, 'the new threshold is in force on the next call')
})
