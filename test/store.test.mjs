import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { TodoError } from '../lib/errors.js'
import { SCHEMA_VERSION } from '../lib/model.js'
import { createStore, resolveHomeDir, resolveStorePath } from '../lib/store.js'

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-store-'))
  return { dir, file: path.join(dir, 'todos.json'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('the default location is $DSH_HOME/global-todo/todos.json', () => {
  assert.equal(resolveHomeDir({ DSH_HOME: '/home/me/.dsh' }), '/home/me/.dsh')
  assert.equal(resolveStorePath({}, { DSH_HOME: '/home/me/.dsh' }), '/home/me/.dsh/global-todo/todos.json')
  assert.equal(resolveStorePath({ storePath: '/notes/todos.json' }, { DSH_HOME: '/x' }), '/notes/todos.json')
  assert.match(resolveHomeDir({}), /\.dsh$/)
})

test('a missing file reads as an empty list and is created on first write', async () => {
  const space = await workspace()
  try {
    const store = createStore({ file: space.file })
    assert.deepEqual(await store.all(), [])
    assert.equal((await store.describe()).exists, false)

    await store.update((doc) => {
      doc.todos.push({ id: 't-1', title: 'A', createdAt: 1, updatedAt: 1, links: [], tags: [], activity: [] })
      return { next: doc.todos, result: null }
    })

    const raw = JSON.parse(await readFile(space.file, 'utf8'))
    assert.equal(raw.version, SCHEMA_VERSION)
    assert.equal(raw.todos.length, 1)
    assert.equal((await store.describe()).exists, true)
  } finally {
    await space.cleanup()
  }
})

test('writes are atomic: no temp file survives, and the payload is complete', async () => {
  const space = await workspace()
  try {
    const store = createStore({ file: space.file })
    await store.update((doc) => {
      for (let index = 0; index < 25; index += 1) {
        doc.todos.push({ id: `t-${index}`, title: `T${index}`, createdAt: index, updatedAt: index, links: [], tags: [], activity: [] })
      }
      return { next: doc.todos, result: null }
    })
    const entries = await readdir(space.dir)
    assert.deepEqual(entries, ['todos.json'])
    const parsed = JSON.parse(await readFile(space.file, 'utf8'))
    assert.equal(parsed.todos.length, 25)
  } finally {
    await space.cleanup()
  }
})

test('concurrent writes are serialized, so no update is lost', async () => {
  const space = await workspace()
  try {
    const store = createStore({ file: space.file })
    await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        store.update((doc) => {
          doc.todos.push({ id: `t-${index}`, title: `T${index}`, createdAt: index, updatedAt: index, links: [], tags: [], activity: [] })
          return { next: doc.todos, result: index }
        }),
      ),
    )
    const todos = await store.all()
    assert.equal(todos.length, 20)
    assert.equal(new Set(todos.map((todo) => todo.id)).size, 20)
  } finally {
    await space.cleanup()
  }
})

test('a failed write does not wedge the write chain', async () => {
  const space = await workspace()
  try {
    const store = createStore({ file: space.file })
    await assert.rejects(
      () => store.update(() => ({ next: 'not an array', result: null })),
      (error) => error instanceof TodoError,
    )
    const result = await store.update((doc) => {
      doc.todos.push({ id: 't-ok', title: 'after failure', createdAt: 1, updatedAt: 1, links: [], tags: [], activity: [] })
      return { next: doc.todos, result: 'ok' }
    })
    assert.equal(result, 'ok')
    assert.equal((await store.all()).length, 1)
  } finally {
    await space.cleanup()
  }
})

test('a corrupt file is an error, never a silent reset', async () => {
  const space = await workspace()
  try {
    await writeFile(space.file, '{ not json', 'utf8')
    const store = createStore({ file: space.file })
    await assert.rejects(() => store.all(), (error) => error.code === 'store-corrupt')
    await assert.rejects(() => store.update(() => ({ result: null })), (error) => error.code === 'store-corrupt')
    assert.equal(await readFile(space.file, 'utf8'), '{ not json', 'the damaged file must be left for the user to recover')
  } finally {
    await space.cleanup()
  }
})

test('a file from a newer schema is refused instead of downgraded', async () => {
  const space = await workspace()
  try {
    await writeFile(space.file, JSON.stringify({ version: SCHEMA_VERSION + 1, todos: [] }), 'utf8')
    const store = createStore({ file: space.file })
    await assert.rejects(() => store.all(), (error) => error.code === 'store-corrupt' && /schema 版本/.test(error.message))
  } finally {
    await space.cleanup()
  }
})

test('damaged rows are skipped while healthy rows survive', async () => {
  const space = await workspace()
  try {
    const good = { id: 't-good', title: '健康', createdAt: 5, updatedAt: 5, links: [], tags: [], activity: [] }
    await writeFile(
      space.file,
      JSON.stringify({ version: SCHEMA_VERSION, todos: [good, { title: 'no id' }, 'junk', { id: 't-dup', title: 'x' }] }),
      'utf8',
    )
    const store = createStore({ file: space.file })
    const todos = await store.all()
    assert.equal(todos.length, 2)
    assert.equal(todos[0].id, 't-good')
    assert.equal(todos[1].id, 't-dup')
  } finally {
    await space.cleanup()
  }
})


test('a change made outside this process is reported once, our own writes are not', async () => {
  const space = await workspace()
  try {
    const store = createStore({ file: space.file })
    const todo = { id: 't-1', title: 'A', createdAt: 1, updatedAt: 1, links: [], tags: [], activity: [] }
    await store.update((doc) => {
      doc.todos.push(todo)
      return { next: doc.todos, result: null }
    })
    assert.equal((await store.describe()).externalChanges, 0, 'our own write is the baseline')
    await store.update((doc) => {
      doc.todos.push({ ...todo, id: 't-2', title: 'B' })
      return { next: doc.todos, result: null }
    })
    assert.equal((await store.describe()).externalChanges, 0, 'a second own write is still not external')

    // Another machine (or a sync client) writes the same file.
    const doc = JSON.parse(await readFile(space.file, 'utf8'))
    doc.todos.push({ ...todo, id: 't-3', title: 'C' })
    await writeFile(space.file, `${JSON.stringify(doc, null, 2)}\n`)
    assert.equal((await store.all()).length, 3)
    const after = await store.describe()
    assert.equal(after.externalChanges, 1)
    assert.equal(typeof after.lastExternalAt, 'number')

    // Polling again must not count the same change twice.
    await store.all()
    assert.equal((await store.describe()).externalChanges, 1)
  } finally {
    await space.cleanup()
  }
})

test('an unwritable location reports itself instead of throwing raw errors', async () => {
  const space = await workspace()
  try {
    // A regular file where the store needs a directory: mkdir fails with
    // ENOTDIR on every platform, so the store must translate it.
    const blocked = path.join(space.dir, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')
    const store = createStore({ file: path.join(blocked, 'todos.json') })
    await assert.rejects(
      () =>
        store.update((doc) => {
          doc.todos.push({ id: 't-1', title: 'A', createdAt: 1, updatedAt: 1, links: [], tags: [], activity: [] })
          return { next: doc.todos, result: null }
        }),
      (error) => error instanceof TodoError && error.code === 'store-unwritable',
    )
  } finally {
    await space.cleanup()
  }
})
