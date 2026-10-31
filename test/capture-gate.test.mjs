import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DAILY_LIST_LIMIT, createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'

async function harness(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-gate-'))
  const file = path.join(dir, 'todos.json')
  if (options.seed !== undefined) await writeFile(file, JSON.stringify(options.seed), 'utf8')
  const store = createStore({ file })
  const service = createService({
    store,
    config: { requireExistingFiles: false },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { dir, file, store, service, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const DAY = 24 * 60 * 60 * 1000
const inHours = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString()

test('an agent record without a deadline waits in the inbox instead of joining the list', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '回头看看日志' }, { by: 'agent', source: 'tool' })
    assert.equal(todo.inboxReason, 'no-due')
    assert.ok(todo.tags.includes('inbox'), 'the record carries the inbox tag')
    assert.equal(todo.captureSource, 'tool')
    assert.equal(todo.priority, 'low', 'no deadline means 低, whatever the model wanted')
    assert.ok(
      todo.activity.some((entry) => entry.kind === 'inboxed'),
      'why it is waiting is on the record',
    )

    // Out of the list, into the inbox — and the counts agree with what is rendered.
    const list = await env.service.list({})
    assert.deepEqual(list.todos.map((entry) => entry.id), [])
    assert.equal(list.counts.open, 0)
    assert.equal(list.counts.total, 0)
    assert.equal(list.counts.inbox, 1)
    const inbox = await env.service.list({ tag: 'inbox' })
    assert.deepEqual(inbox.todos.map((entry) => entry.id), [todo.id])
  } finally {
    await env.cleanup()
  }
})

test('a deadline puts an agent record on the list, and the level follows the deadline', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create(
      { title: '交周报', dueAt: inHours(20), priority: 'low' },
      { by: 'agent', source: 'tool' },
    )
    assert.equal(todo.inboxReason, '')
    assert.ok(!todo.tags.includes('inbox'))
    assert.equal(todo.priority, 'high', '20 hours out is P1, not what the model asked for')
    assert.equal(todo.suggestedPriority, 'low', 'the request is kept, it just does not decide')
    const list = await env.service.list({})
    assert.deepEqual(list.todos.map((entry) => entry.id), [todo.id])
  } finally {
    await env.cleanup()
  }
})

test('a person\'s own entry is never gated, and keeps the level they chose', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '买牛奶' }, { by: 'human', source: 'human' })
    assert.equal(todo.inboxReason, '')
    assert.equal(todo.prioritySource, 'human')
    assert.equal(todo.priority, 'normal', 'a person typing is the decision')
    const list = await env.service.list({})
    assert.deepEqual(list.todos.map((entry) => entry.id), [todo.id])
  } finally {
    await env.cleanup()
  }
})

test('the day\'s allowance stops the list from becoming the write path', async () => {
  const env = await harness()
  try {
    for (let index = 0; index < DAILY_LIST_LIMIT; index += 1) {
      const todo = await env.service.create(
        { title: `今天第 ${index + 1} 件`, dueAt: inHours(72) },
        { by: 'agent', source: 'tool' },
      )
      assert.equal(todo.inboxReason, '', `record ${index + 1} should be on the list`)
    }
    const overflow = await env.service.create({ title: '今天第 9 件', dueAt: inHours(72) }, { by: 'agent', source: 'tool' })
    assert.equal(overflow.inboxReason, 'quota', 'past the allowance it waits, it is not dropped')
    assert.ok(overflow.tags.includes('inbox'))
    assert.equal((await env.service.list({})).counts.total, DAILY_LIST_LIMIT)
    assert.equal((await env.service.list({})).counts.inbox, 1)
  } finally {
    await env.cleanup()
  }
})

test('confirming an inbox record moves it onto the list and drops the reason', async () => {
  const env = await harness()
  try {
    const todo = await env.service.create({ title: '还没定日期' }, { by: 'agent', source: 'capture' })
    assert.equal(todo.inboxReason, 'no-due')
    await env.service.bulk([todo.id], { removeTags: ['inbox'] }, { by: 'human' })
    const after = await env.service.get(todo.id)
    assert.ok(!after.tags.includes('inbox'))
    assert.equal(after.inboxReason, '')
    assert.deepEqual((await env.service.list({})).todos.map((entry) => entry.id), [todo.id])
  } finally {
    await env.cleanup()
  }
})

test('an ingest item keeps its own confidence gate instead of the deadline gate', async () => {
  const env = await harness()
  try {
    const result = await env.service.ingest([{ title: '邮件里的事', source: { kind: 'mail' }, confidence: 0.95 }], {
      confirmBelow: 0.8,
    })
    assert.equal(result.created.length, 1)
    const todo = result.created[0]
    assert.equal(todo.captureSource, 'ingest')
    assert.equal(todo.inboxReason, '')
    assert.ok(!todo.tags.includes('inbox'), 'high confidence external items still join the list')
  } finally {
    await env.cleanup()
  }
})

test('a record already waiting in the inbox is not captured a second time', async () => {
  const env = await harness()
  try {
    const first = await env.service.create({ title: '等对方回信' }, { by: 'agent', source: 'capture' })
    assert.equal(first.inboxReason, 'no-due')
    const { findDuplicate } = await import('../lib/capture.js')
    const verdict = findDuplicate({ title: '等对方回信', existing: await env.service.listAll() })
    assert.equal(verdict.duplicate, true, 'the inbox is part of the list for duplicate purposes')
  } finally {
    await env.cleanup()
  }
})

test('capturedSince answers "did this conversation record something in this turn"', async () => {
  const env = await harness()
  try {
    const before = Date.now()
    const todo = await env.service.create(
      { title: '这一轮记的', dueAt: inHours(72) },
      { by: 'agent', source: 'tool', origin: { sessionId: 'session-a', dir: '/repo' } },
    )
    const hit = await env.service.capturedSince('session-a', before - 1000)
    assert.equal(hit.id, todo.id)
    assert.equal(await env.service.capturedSince('session-a', Date.now() + 1000), null, 'a later window sees nothing')
    assert.equal(await env.service.capturedSince('session-b', before - 1000), null, 'another conversation is not this one')
  } finally {
    await env.cleanup()
  }
})

test('the one-time migration gates what is already there, and leaves a person\'s edit alone', async () => {
  const now = Date.UTC(2026, 9, 30, 4)
  const env = await harness({
    now: () => now,
    seed: {
      version: 2,
      todos: [
        {
          id: 't-rule',
          title: '没有日期的「高」',
          status: 'open',
          priority: 'high',
          createdBy: 'agent',
          updatedBy: 'agent',
          createdAt: now - DAY,
          updatedAt: now - DAY,
        },
        {
          id: 't-human',
          title: '人改过的高',
          status: 'open',
          priority: 'high',
          createdBy: 'agent',
          updatedBy: 'human',
          createdAt: now - DAY,
          updatedAt: now - DAY,
        },
        {
          id: 't-due',
          title: '明天到期的高',
          status: 'open',
          priority: 'normal',
          dueAt: new Date(now + 20 * 3600 * 1000).toISOString(),
          createdBy: 'agent',
          updatedBy: 'agent',
          createdAt: now - DAY,
          updatedAt: now - DAY,
        },
      ],
      trash: [],
    },
  })
  try {
    const first = await env.service.migrate({ now })
    // The agent's undated record moves to the inbox (a sweep, not a delete); the dated one is
    // re-levelled; the record a person touched is left exactly where it is.
    assert.deepEqual(first, { inboxed: 1, releveled: 1 })
    const byId = new Map((await env.service.listAll()).map((todo) => [todo.id, todo]))
    assert.equal(byId.get('t-rule').inboxReason, 'no-due')
    assert.ok(byId.get('t-rule').tags.includes('inbox'))
    assert.equal(byId.get('t-human').inboxReason, '', 'a person\'s record is not swept')
    assert.equal(byId.get('t-human').priority, 'high', 'and their level is never recomputed')
    assert.equal(byId.get('t-human').prioritySource, 'human')
    assert.equal(byId.get('t-due').priority, 'high', 'a deadline 20 hours out is 高')
    assert.deepEqual(await env.service.migrate({ now }), { inboxed: 0, releveled: 0 }, 'running it again changes nothing')
    const onDisk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.equal(onDisk.todos.find((todo) => todo.id === 't-rule').inboxReason, 'no-due', 'the migration is persisted')
    assert.equal(onDisk.todos.find((todo) => todo.id === 't-due').priority, 'high')
  } finally {
    await env.cleanup()
  }
})
