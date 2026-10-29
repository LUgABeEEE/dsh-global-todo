import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { TodoError } from '../lib/errors.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { HUB_FILE, createSync } from '../lib/sync.js'

/** One machine: its own store and service, nothing shared with the other. */
async function machine(root, name) {
  const dir = path.join(root, name)
  const file = path.join(dir, 'todos.json')
  const store = createStore({ file })
  const service = createService({ store, config: { requireExistingFiles: false } })
  return { name, dir, file, store, service }
}

/** Two machines and the share they meet in. */
async function fleet() {
  const root = await mkdtemp(path.join(tmpdir(), 'gt-sync-'))
  const share = path.join(root, 'share')
  const left = await machine(root, 'left')
  const right = await machine(root, 'right')
  const syncOf = (box) => createSync({ store: box.store, config: { dir: share } })
  return { root, share, left, right, syncOf, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const titles = async (machineUnderTest) => (await machineUnderTest.service.list({ status: 'all' })).todos.map((todo) => todo.title).sort()

test('two machines meet at the hub and end up with one list', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '左一' })
    await env.left.service.create({ title: '左二' })
    const first = await env.syncOf(env.left).run()
    assert.equal(first.stats.total, 2)
    assert.equal(first.hubCreated, true, 'the first sync creates the hub')

    await env.right.service.create({ title: '右一' })
    const second = await env.syncOf(env.right).run()
    assert.deepEqual(await titles(env.right), ['右上'.replace('上', '一'), '左一', '左二'].sort(), 'the right machine receives the left list')
    assert.equal(second.stats.received, 2)

    const third = await env.syncOf(env.left).run()
    assert.deepEqual(await titles(env.left), ['右一', '左一', '左二'].sort(), 'and the left machine receives what it missed')
    assert.equal(third.stats.received, 1)

    // The hub is a normal document, so a third machine could simply copy it in.
    const hub = JSON.parse(await readFile(path.join(env.share, HUB_FILE), 'utf8'))
    assert.equal(hub.todos.length, 3)
    assert.equal(hub.version, 2)
  } finally {
    await env.cleanup()
  }
})

test('a deletion on one machine is not undone by the other machine copying it back', async () => {
  const env = await fleet()
  try {
    const keep = await env.left.service.create({ title: '留着' })
    const drop = await env.left.service.create({ title: '删掉' })
    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()
    assert.deepEqual(await titles(env.right), ['删掉', '留着'].sort())

    await env.left.service.remove(drop.id)
    const pushed = await env.syncOf(env.left).run()
    assert.equal(pushed.stats.removed, 0, 'the record is already gone here')
    const pulled = await env.syncOf(env.right).run()
    assert.equal(pulled.stats.removed, 1, 'the other machine learns about the deletion')
    assert.deepEqual(await titles(env.right), ['留着'])
    assert.equal(keep.id.length > 0, true)
  } finally {
    await env.cleanup()
  }
})

test('restoring a record on one machine keeps it alive on the other', async () => {
  const env = await fleet()
  try {
    const todo = await env.left.service.create({ title: '删了又回来' })
    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()

    const record = todo
    await env.left.service.remove(todo.id)
    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()
    assert.deepEqual(await titles(env.right), [])

    await env.left.service.restore(record, { by: 'human' })
    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()
    assert.deepEqual(await titles(env.right), ['删了又回来'], 'the undo has to revoke the tombstone, not only re-add the row')
  } finally {
    await env.cleanup()
  }
})

test('two machines editing different todos keep both edits', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '甲' })
    await env.left.service.create({ title: '乙' })
    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()

    const [first, second] = (await env.left.service.list({ status: 'all' })).todos
    await new Promise((resolve) => setTimeout(resolve, 5))
    await env.left.service.update(first.id, { title: '甲（左改）' })
    await env.right.service.update(second.id, { title: '乙（右改）' })

    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()
    await env.syncOf(env.left).run()

    assert.deepEqual(await titles(env.left), ['乙（右改）', '甲（左改）'].sort())
    assert.deepEqual(await titles(env.right), ['乙（右改）', '甲（左改）'].sort())
  } finally {
    await env.cleanup()
  }
})

test('a sync that changes nothing writes nothing', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '稳定' })
    await env.syncOf(env.left).run()
    const before = { local: (await stat(env.left.file)).mtimeMs, hub: (await stat(path.join(env.share, HUB_FILE))).mtimeMs }
    await new Promise((resolve) => setTimeout(resolve, 5))

    const again = await env.syncOf(env.left).run()
    assert.equal(again.stats.sent, 0)
    assert.equal(again.stats.received, 0)
    assert.equal(again.wrote.local, false)
    assert.equal(again.wrote.hub, false)
    assert.equal((await stat(env.left.file)).mtimeMs, before.local)
    assert.equal((await stat(path.join(env.share, HUB_FILE))).mtimeMs, before.hub)
  } finally {
    await env.cleanup()
  }
})

test('a dry run reports the fold and writes neither side', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '左' })
    const dry = await env.syncOf(env.left).run({ dryRun: true })
    assert.equal(dry.stats.total, 1)
    assert.equal(dry.wrote.hub, false)
    assert.equal(dry.wrote.local, false)
    await assert.rejects(stat(path.join(env.share, HUB_FILE)), 'the hub must not be created by a dry run')

    const local = JSON.parse(await readFile(env.left.file, 'utf8'))
    assert.equal(local.trash.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('a share that is not there is reported, and the local list is untouched', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '本机还在' })
    const before = await readFile(env.left.file, 'utf8')
    const sync = createSync({ store: env.left.store, config: { dir: path.join(env.root, 'missing-parent', 'share') } })
    await assert.rejects(sync.run(), (error) => {
      assert.equal(error.code, 'sync-unavailable')
      return true
    })
    assert.equal(await readFile(env.left.file, 'utf8'), before)
  } finally {
    await env.cleanup()
  }
})

test('a corrupt hub is refused instead of being overwritten', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '本机' })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(env.share, { recursive: true })
    const hubFile = path.join(env.share, HUB_FILE)
    await writeFile(hubFile, '{ not json', 'utf8')

    await assert.rejects(env.syncOf(env.left).run(), (error) => {
      assert.equal(error.code, 'sync-corrupt')
      return true
    })
    assert.equal(await readFile(hubFile, 'utf8'), '{ not json', 'a file with unknown content is not replaced')
  } finally {
    await env.cleanup()
  }
})

test('the directory can come from a setting that changes while the Host runs', async () => {
  const env = await fleet()
  try {
    const share = env.share
    // A getter, not a captured value: this is how the panel's field reaches the sync, and a
    // captured path would keep writing to the directory that was set yesterday.
    let current = ''
    const sync = createSync({
      store: env.left.store,
      getDir: () => current,
      getInterval: () => 5,
    })
    await env.left.service.create({ title: '切换目录前' })
    await assert.rejects(sync.run(), (error) => error.code === 'sync-not-configured')

    current = share
    const first = await sync.run()
    assert.equal(first.stats.total, 1)
    assert.equal(sync.describe().configured, true)
    assert.equal(sync.describe().dir, share)

    current = ''
    assert.equal(sync.describe().configured, false, 'clearing the field turns the machine back into a single one')
    await assert.rejects(sync.run(), (error) => error.code === 'sync-not-configured')
  } finally {
    await env.cleanup()
  }
})

test('an unconfigured share says so instead of doing something', async () => {
  const env = await fleet()
  try {
    const sync = createSync({ store: env.left.store, config: {} })
    assert.equal(sync.describe().configured, false)
    await assert.rejects(sync.run(), (error) => {
      assert.equal(error.code, 'sync-not-configured')
      return true
    })
  } finally {
    await env.cleanup()
  }
})

test('a record created while offline on both machines is numbered once', async () => {
  const env = await fleet()
  try {
    await env.left.service.create({ title: '左' })
    await env.right.service.create({ title: '右' })
    await env.syncOf(env.left).run()
    await env.syncOf(env.right).run()
    await env.syncOf(env.left).run()

    const left = (await env.left.service.list({ status: 'all' })).todos.map((todo) => todo.seq).sort((a, b) => a - b)
    const right = (await env.right.service.list({ status: 'all' })).todos.map((todo) => todo.seq).sort((a, b) => a - b)
    assert.deepEqual(left, [1, 2])
    assert.deepEqual(right, left, 'both machines agree on the numbers a person quotes')
  } finally {
    await env.cleanup()
  }
})

test('the status survives for /health: last result, and why it failed', async () => {
  const env = await fleet()
  try {
    const sync = env.syncOf(env.left)
    await env.left.service.create({ title: '看得见' })
    assert.equal(sync.describe().last, null)
    await sync.run()
    const ok = sync.describe()
    assert.equal(ok.last.ok, true)
    assert.equal(ok.configured, true)
    assert.equal(ok.dir, env.share)

    const broken = createSync({ store: env.left.store, config: { dir: path.join(env.root, 'nope', 'share') } })
    await assert.rejects(broken.run(), (error) => error instanceof TodoError)
    assert.equal(broken.describe().last.ok, false)
    assert.match(broken.describe().error, /共享/)
  } finally {
    await env.cleanup()
  }
})
