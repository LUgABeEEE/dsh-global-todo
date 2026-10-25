import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createFileLock } from '../lib/lockfile.js'
import { createStore } from '../lib/store.js'

/**
 * The bug these cover: every write is 'read the whole list, change it, rename it back', so two
 * processes that read at the same moment each write a list that does not contain the other's
 * change - and both calls return success. A user reported exactly that with two agents.
 *
 * The lock is a sibling file (todos.json.lock) created with 'wx'; these tests pin the three
 * properties that make it safe: it excludes, it is not stolen from a live holder, and it is
 * cleaned up after a crash so the list does not stay locked forever.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

async function space() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-lock-'))
  return {
    dir,
    file: path.join(dir, 'todos.json'),
    lock: path.join(dir, 'todos.json.lock'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** A pid that existed a moment ago and does not exist now. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((resolve) => child.on('exit', resolve))
  return pid
}

function candy(id, title = id) {
  return { id, title, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, links: [], tags: [], activity: [] }
}

test('two stores on one file never lose a change', async () => {
  const s = await space()
  try {
    const left = createStore({ file: s.file })
    const right = createStore({ file: s.file })
    const add = (store, name) =>
      store.update((doc) => {
        doc.todos.push(candy('t-' + name, name))
        return { next: doc.todos, result: null }
      })

    const jobs = []
    for (let i = 0; i < 10; i += 1) {
      jobs.push(add(left, 'left' + i), add(right, 'right' + i))
    }
    await Promise.all(jobs)

    const doc = JSON.parse(await readFile(s.file, 'utf8'))
    assert.equal(doc.todos.length, 20, 'every one of the twenty writes survived')
    assert.equal(new Set(doc.todos.map((todo) => todo.id)).size, 20, 'no id was written twice')
    assert.deepEqual(
      (await readdir(s.dir)).filter((name) => name.endsWith('.lock')),
      [],
      'the lock file is gone when the last writer finishes',
    )
  } finally {
    await s.cleanup()
  }
})

test('a lock held by a live process is waited on, then reported as store-busy - never stolen', async () => {
  const s = await space()
  try {
    // Our own pid is alive, so the same-host rule must protect the lock whatever its age says.
    await writeFile(s.lock, JSON.stringify({ pid: process.pid, host: hostname(), at: 1, token: 'theirs' }) + '\n')
    const old = new Date(Date.now() - 120_000)
    await utimes(s.lock, old, old)

    const store = createStore({ file: s.file, lockTimeoutMs: 150 })
    let code = null
    await store.update(() => ({ result: null })).catch((error) => {
      code = error.code
    })
    assert.equal(code, 'store-busy')
    assert.equal(JSON.parse(await readFile(s.lock, 'utf8')).token, 'theirs', 'the foreign lock was left alone')
  } finally {
    await s.cleanup()
  }
})

test('a lock left behind by a dead process is reaped at once, so the list cannot stay locked', async () => {
  const s = await space()
  try {
    const pid = await deadPid()
    // Deliberately fresh: on the same host the pid decides, not the clock. Waiting for 30 s of
    // age here would mean the reap lands long after every waiter has already failed at 5 s.
    await writeFile(s.lock, JSON.stringify({ pid, host: hostname(), at: 1, token: 'ghost' }) + '\n')

    const store = createStore({ file: s.file, lockTimeoutMs: 3000 })
    await store.update((doc) => {
      doc.todos.push(candy('t-ghost'))
      return { next: doc.todos, result: null }
    })
    assert.equal(JSON.parse(await readFile(s.file, 'utf8')).todos.length, 1)
    assert.equal(await exists(s.lock), false)
  } finally {
    await s.cleanup()
  }
})

test('a lock from another machine is waited on while fresh and reaped when old', async () => {
  const s = await space()
  try {
    await writeFile(s.lock, JSON.stringify({ pid: 4242, host: 'some-other-box', at: 1, token: 'remote' }) + '\n')

    let code = null
    await createStore({ file: s.file, lockTimeoutMs: 150 })
      .update(() => ({ result: null }))
      .catch((error) => {
        code = error.code
      })
    assert.equal(code, 'store-busy', 'age is not evidence yet')

    const old = new Date(Date.now() - 120_000)
    await utimes(s.lock, old, old)
    await createStore({ file: s.file, lockTimeoutMs: 3000 }).update(() => ({ result: null }))
    assert.equal(await exists(s.lock), false)
  } finally {
    await s.cleanup()
  }
})

test('releasing a lock somebody else retook does not delete theirs', async () => {
  const s = await space()
  try {
    const lock = createFileLock({ file: s.lock, timeoutMs: 100 })
    await lock.acquire()
    // Pretend our lock was declared abandoned, removed, and taken by another process.
    await writeFile(s.lock, JSON.stringify({ pid: 1, host: 'elsewhere', at: 1, token: 'another' }) + '\n')
    await lock.release()
    assert.equal(await exists(s.lock), true, 'a foreign token must survive our release')
  } finally {
    await s.cleanup()
  }
})

test('a mutation that throws still releases the lock', async () => {
  const s = await space()
  try {
    const store = createStore({ file: s.file })
    await store
      .update(() => {
        throw new Error('boom')
      })
      .catch(() => {})
    assert.equal(await exists(s.lock), false)

    await store.update((doc) => {
      doc.todos.push(candy('t-after'))
      return { next: doc.todos, result: null }
    })
    assert.equal(JSON.parse(await readFile(s.file, 'utf8')).todos.length, 1, 'the next write works')
  } finally {
    await s.cleanup()
  }
})

test('two real processes adding to one list keep all twenty entries', async () => {
  const s = await space()
  const moduleUrl = pathToFileURL(path.join(root, 'lib/store.js')).href
  const child = [
    'const { createStore } = await import(process.env.GT_MODULE)',
    'const store = createStore({ file: process.env.GT_FILE })',
    'const tag = process.env.GT_TAG',
    'for (let i = 0; i < 10; i += 1) {',
    '  await store.update((doc) => {',
    '    doc.todos.push({',
    '      id: "t-" + tag + "-" + i,',
    '      title: tag + "-" + i,',
    '      createdAt: 1700000000000 + i,',
    '      updatedAt: 1700000000000 + i,',
    '      links: [],',
    '      tags: [],',
    '      activity: [],',
    '    })',
    '    return { next: doc.todos, result: null }',
    '  })',
    '}',
  ].join('\n')

  const runChild = (tag) =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', child], {
        env: { ...process.env, GT_MODULE: moduleUrl, GT_FILE: s.file, GT_TAG: tag },
        stdio: 'ignore',
      })
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('child exited ' + code))))
    })

  try {
    await Promise.all([runChild('alpha'), runChild('bravo')])
    const doc = JSON.parse(await readFile(s.file, 'utf8'))
    assert.equal(doc.todos.length, 20, 'both processes kept every write they acknowledged')
    assert.equal(new Set(doc.todos.map((todo) => todo.title)).size, 20)
    assert.equal(await exists(s.lock), false)
  } finally {
    await s.cleanup()
  }
})
