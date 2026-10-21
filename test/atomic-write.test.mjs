import test from 'node:test'
import assert from 'node:assert/strict'
import { atomicWrite } from '../lib/store.js'

/** A fake fs/promises surface: records what the writer asked for, and fails where told. */
function fakeFs({ failWrite = false, failSync = false } = {}) {
  const calls = { open: [], written: '', synced: 0, renamed: [], unlinked: [] }
  const fs = {
    async open(target, flags) {
      calls.open.push({ target, flags })
      return {
        async writeFile(data) {
          if (failWrite) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
          calls.written += data
        },
        async sync() {
          calls.synced += 1
          if (failSync) throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' })
        },
        async close() {},
      }
    },
    async rename(from, to) {
      calls.renamed.push({ from, to })
    },
    async unlink(target) {
      calls.unlinked.push(target)
    },
  }
  return { fs, calls }
}

test('the temp file is opened for writing: a read-only handle cannot be fsynced on Windows', async () => {
  const { fs, calls } = fakeFs()
  await atomicWrite('/tmp/store/todos.json', '{"version":1,"todos":[]}', { fs })
  assert.equal(calls.open.length, 1)
  assert.equal(calls.open[0].flags, 'w', 'must not reopen the temp file read-only (issue #2)')
  assert.equal(calls.synced, 1)
  assert.deepEqual(calls.renamed.map((call) => call.to), ['/tmp/store/todos.json'])
})

test('a sync the platform refuses does not lose the save', async () => {
  const { fs, calls } = fakeFs({ failSync: true })
  const errors = []
  await atomicWrite('/tmp/store/todos.json', '{"version":1,"todos":[]}', { fs, onSyncError: (error) => errors.push(error) })
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /EPERM/)
  assert.equal(calls.renamed.length, 1, 'the rename must still happen')
  assert.deepEqual(calls.unlinked, [], 'nothing to clean up after a successful rename')
})

test('a failed write leaves no debris and reports the failure', async () => {
  const { fs, calls } = fakeFs({ failWrite: true })
  await assert.rejects(() => atomicWrite('/tmp/store/todos.json', 'x', { fs }), /ENOSPC/)
  assert.equal(calls.renamed.length, 0)
  assert.equal(calls.unlinked.length, 1, 'the temp file is removed when the write fails')
})

test('the payload actually reaches the file before it is renamed', async () => {
  const { fs, calls } = fakeFs()
  const payload = '{"version":1,"todos":[{"id":"t-1","title":"x"}]}'
  await atomicWrite('/tmp/store/todos.json', payload, { fs })
  assert.equal(calls.written, payload)
})
