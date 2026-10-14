import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDiagnostics } from '../lib/diagnostics.js'

test('panel failures are recorded, trimmed, and readable newest first', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-diag-'))
  const file = path.join(dir, 'client-errors.log')
  try {
    let clock = 1000
    const diag = createDiagnostics({ file, now: () => (clock += 1000) })
    assert.deepEqual(diag.recent(), [], 'nothing recorded is the normal case')

    const stored = diag.record({
      scope: 'call',
      status: 401,
      reason: 'forbidden',
      message: 'list: 请求被宿主连接围栏拒绝',
      url: 'http://192.168.1.10:3080/',
      junk: 'dropped',
    })
    assert.equal(stored.status, 401)
    assert.equal(stored.junk, undefined, 'unknown fields are dropped')
    assert.equal(stored.scope, 'call')

    diag.record({ scope: 'settings', message: 'x'.repeat(2000) })
    const recent = diag.recent()
    assert.equal(recent.length, 2, 'newest first')
    assert.equal(recent[0].scope, 'settings')
    assert.ok(recent[0].message.length <= 400, 'a report cannot flood the log')

    // An empty report is not evidence and is not stored.
    assert.equal(diag.record({}), null)
    assert.equal(diag.record(null), null)
    assert.equal(diag.record('nope'), null)

    await new Promise((resolve) => setTimeout(resolve, 60))
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2, 'both reports are on disk')

    // A fresh instance reads what the previous one wrote, so a restart keeps the trail.
    const reopened = createDiagnostics({ file, now: () => 5000 })
    await reopened.load()
    assert.equal(reopened.recent().length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the on-disk trail stays bounded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-diag-cap-'))
  const file = path.join(dir, 'client-errors.log')
  try {
    const diag = createDiagnostics({ file })
    for (let index = 0; index < 70; index += 1) diag.record({ scope: 'call', message: `report ${index}` })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.ok(lines.length <= 50, `expected at most 50 lines, got ${lines.length}`)
    assert.match(lines.at(-1), /report 69/, 'the newest report is the one that survives')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
