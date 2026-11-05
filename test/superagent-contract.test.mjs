import { strict as assert } from 'node:assert'
import test from 'node:test'

import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The contract an orchestrator (dsh-superagent) relies on. It is stated in
 * docs/SUPERAGENT.md; these assertions are what keeps the document honest.
 *
 * The load-bearing one is the last: an agent's reply must stop the record from
 * being read as a person's request again, or a worker replying to a ticket
 * triggers itself forever.
 */
async function service() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-superagent-'))
  const store = createStore({ file: path.join(dir, 'todos.json') })
  const instance = createService({ store, config: { requireExistingFiles: false } })
  return { instance, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('a record is only a request when a person wrote it and gave it a directory', async () => {
  const { instance, cleanup } = await service()
  try {
    const byAgent = await instance.create({ title: 'agent 自己加的' }, { by: 'agent', source: 'tool' })
    assert.equal(byAgent.createdBy, 'agent')

    // Barely-written records carry no directory: there is nowhere to work.
    const byHuman = await instance.create({ title: '人写的' }, { by: 'human' })
    assert.equal(byHuman.createdBy, 'human')
    assert.equal(byHuman.originDir, '')
  } finally {
    await cleanup()
  }
})

test("an agent's note is the agent's, and it takes the record out of the request set", async () => {
  const { instance, cleanup } = await service()
  try {
    const todo = await instance.create({ title: '要做的事' }, { by: 'human', origin: { dir: '/tmp/work' } })
    assert.equal(todo.updatedBy, 'human')
    assert.equal(todo.originDir, '/tmp/work', 'the directory is what tells a worker where to start')

    const before = todo.updatedAt
    await instance.note(todo.id, '做完了：改了 a.js，测试通过', { by: 'agent' })
    const after = await instance.get(todo.id)

    assert.equal(after.notes.at(-1).by, 'agent', 'the reply is attributed to the agent, not the person')
    assert.equal(after.updatedBy, 'agent', 'and the record now looks agent-authored')

    // The update stamp is the other half of the stop: a trigger identity that
    // includes updatedAt must not match the one that produced this reply.
    assert.ok(after.updatedAt >= before)

    // A person touching it again puts it back in the request set — the only way back.
    await instance.note(todo.id, '再跑一次', { by: 'human' })
    assert.equal((await instance.get(todo.id)).updatedBy, 'human')
  } finally {
    await cleanup()
  }
})

test('a reply does not finish the record', async () => {
  const { instance, cleanup } = await service()
  try {
    const todo = await instance.create({ title: '不要自动完成' }, { by: 'human', origin: { dir: '/tmp/work' } })
    await instance.note(todo.id, '进展', { by: 'agent' })
    const after = await instance.get(todo.id)
    assert.equal(after.status, 'open', 'completion is a person\'s judgement, not the worker\'s')
    assert.equal(after.doneAt, null)
  } finally {
    await cleanup()
  }
})
