import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compose, deliver, describeAge, windowAgeSeconds, windowState } from '../tools/notify.mjs'

// Any existing file will do as the "library": the tests inject the exec, so only the
// existsSync gate matters. fileURLToPath, because the checkout lives under a Chinese path
// and a URL pathname would be percent-encoded (existsSync would then say "absent").
const LIBRARY = fileURLToPath(new URL('../tools/notify.mjs', import.meta.url))

test('the message for each event names the thing a person can act on', () => {
  const release = compose({ kind: 'release', args: ['0.12.9'] })
  assert.match(release, /0\.12\.9/)
  assert.match(release, /npmjs\.com/)
  assert.match(release, /dsh plugin add/)

  assert.match(compose({ kind: 'ci-failed', args: ['39591615478', 'main', 'Package shape'] }), /actions\/runs\/39591615478/)
  assert.match(compose({ kind: 'new-issue', args: ['3', 'Windows sweep'] }), /issues\/3/)
  assert.equal(compose({ kind: 'text', args: ['  随口', '一句 '] }), '随口 一句')
})

test('an empty message or an unknown event is refused, not sent', () => {
  assert.throws(() => compose({ kind: 'text', args: ['   '] }), /空消息/)
  assert.throws(() => compose({ kind: 'nope', args: [] }), /不认识的事件/)
  assert.throws(() => compose({ kind: 'release', args: [] }), /用法/)
})

test('the window is open below the measured boundary and stale above it', () => {
  assert.equal(windowState(5 * 3600), 'open')
  assert.equal(windowState(19 * 3600), 'stale')
  assert.equal(windowState(null), 'unknown')
  assert.equal(windowState(65_535), 'open')
  assert.equal(windowState(65_537), 'stale')
  assert.equal(describeAge(90), '90s')
  assert.equal(describeAge(7200), '2.0h')
  assert.equal(describeAge(null), 'unknown')
})

test('the age comes from the newest context token, and only its timestamp', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-notify-'))
  try {
    await mkdir(path.join(dir, 'a'), { recursive: true })
    await writeFile(path.join(dir, 'a', 'state.json'), JSON.stringify({
      contextTokens: { users: { u1: { messageTimeMs: Date.now() - 3600_000 }, u2: { messageTimeMs: Date.now() - 60_000 } } },
    }), 'utf8')
    const age = await windowAgeSeconds({ accountsDir: dir })
    assert.ok(age !== null && age < 120, `expected ~60s, got ${age}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no token at all is unknown, not an error', async () => {
  assert.equal(await windowAgeSeconds({ accountsDir: path.join(tmpdir(), 'gt-notify-missing') }), null)
})

test('a closed window queues instead of trying and failing', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push({ file, args })
    return { stdout: '/tmp/outbox/123.txt\n' }
  }
  const result = await deliver({ text: 'hi', exec, age: 19 * 3600, library: LIBRARY })
  // library must exist for the call to reach exec
  assert.equal(result.status, 'queued')
  assert.match(calls[0].args.join(' '), /outbox_save/, 'the queue is owned by delivery.sh, not reimplemented here')
})

test('a successful send is only success when delivery.sh says ok', async () => {
  const ok = await deliver({ text: 'hi', age: 60, exec: async () => ({ stdout: 'ok\n' }), library: LIBRARY })
  assert.equal(ok.status, 'sent')
  const err = await deliver({ text: 'hi', age: 60, exec: async () => ({ stdout: 'err:http502\n' }), library: LIBRARY })
  assert.equal(err.status, 'queued', 'a platform error must not be reported as sent')
})

test('without the host delivery library the tool says so instead of pretending', async () => {
  const result = await deliver({ text: 'hi', age: 60, exec: async () => ({ stdout: 'ok' }), library: '/nonexistent/delivery.sh' })
  assert.equal(result.status, 'absent')
})

test('the send snippet passes the library and the text as arguments, not as JS interpolation', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push({ file, args })
    return { stdout: 'ok\n' }
  }
  const result = await deliver({ text: '你好 $HOME', exec, age: 60, library: LIBRARY })
  assert.equal(result.status, 'sent')
  const snippet = calls[0].args[1]
  assert.match(snippet, /\$1/, 'the script must reference $1 literally')
  assert.match(snippet, /\$2/, 'and $2')
  assert.equal(calls[0].args.at(-1), '你好 $HOME', 'the text travels as one argv entry, never through the shell')
})
