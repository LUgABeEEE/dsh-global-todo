import { strict as assert } from 'node:assert'
import test from 'node:test'

import { completeOwnedTodos, ownedOpenTodos } from '../lib/auto-complete.js'

test('a conversation only owns its own unfinished todos', () => {
  const todos = [
    { id: 'a', status: 'open', originSessionId: 'session-me' },
    { id: 'b', status: 'doing', originSessionId: 'session-me' },
    { id: 'c', status: 'done', originSessionId: 'session-me' },
    { id: 'd', status: 'open', originSessionId: 'session-other' },
    { id: 'e', status: 'open' },
  ]
  assert.deepEqual(ownedOpenTodos(todos, 'session-me').map((todo) => todo.id), ['a', 'b'])
  assert.deepEqual(ownedOpenTodos(todos, 'session-other').map((todo) => todo.id), ['d'])
  assert.deepEqual(ownedOpenTodos(todos, ''), [], 'no session, nothing to close')
  assert.deepEqual(ownedOpenTodos(null, 'session-me'), [])
})

test('a quiet conversation has its own work closed, with the reason written down', async () => {
  const completed = []
  const service = {
    async list() {
      return {
        todos: [
          { id: 'mine', status: 'open', originSessionId: 'session-me' },
          { id: 'theirs', status: 'open', originSessionId: 'session-other' },
          { id: 'finished', status: 'done', originSessionId: 'session-me' },
        ],
      }
    },
    async complete(id, evidence, context) {
      completed.push({ id, evidence, context })
    },
  }
  const ids = await completeOwnedTodos({ service, sessionId: 'session-me', summary: '安静下来后自动划掉' })
  assert.deepEqual(ids, ['mine'])
  assert.equal(completed.length, 1, 'only its own open todo is touched')
  assert.equal(completed[0].id, 'mine')
  assert.equal(completed[0].evidence.summary, '安静下来后自动划掉')
  assert.equal(completed[0].context.by, 'agent')
})

test('a failing read or write is reported, never thrown at the caller', async () => {
  const warnings = []
  const logger = { warn: (message) => warnings.push(message) }
  assert.deepEqual(
    await completeOwnedTodos({
      service: { async list() { throw new Error('store corrupt') }, async complete() {} },
      sessionId: 'session-me',
      summary: 'x',
      logger,
    }),
    [],
  )
  assert.equal(warnings.length, 1)

  const ids = await completeOwnedTodos({
    service: {
      async list() { return { todos: [{ id: 'a', status: 'open', originSessionId: 'session-me' }] } },
      async complete() { throw new Error('unwritable') },
    },
    sessionId: 'session-me',
    summary: 'x',
    logger,
  })
  assert.deepEqual(ids, [])
  assert.equal(warnings.length, 2)
})
