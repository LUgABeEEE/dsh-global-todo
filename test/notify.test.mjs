import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compose, deliver, describeAge, flush, windowAgeSeconds, windowState } from '../tools/notify.mjs'

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



test('a failed send is written to the outbox, and lost is reported as lost', async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push(args.join(' '))
    if (calls.length === 1) {
      const error = new Error('Command failed')
      error.stdout = 'err:http502\n'
      throw error
    }
    return { stdout: '/tmp/outbox/9.txt\n' }
  }
  const result = await deliver({ text: 'hi', exec, age: 60, library: LIBRARY })
  assert.equal(result.status, 'queued')
  assert.match(result.detail, /http502/)
  assert.match(calls[1], /outbox_save/, 'a queued status must actually queue')

  const lost = await deliver({
    text: 'hi',
    age: 60,
    library: LIBRARY,
    exec: async () => {
      throw new Error('no bash')
    },
  })
  assert.equal(lost.status, 'lost', 'neither sent nor queued is not a success')
})

test('flush drains the outbox through delivery.sh instead of promising a retry', async () => {
  const calls = []
  const flushed = await flush({
    library: LIBRARY,
    exec: async (file, args) => {
      calls.push(args.join(' '))
      return { stdout: 'OUTBOX 补发成功：20261021-225920.txt\n' }
    },
  })
  assert.equal(flushed.status, 'flushed')
  assert.match(calls[0], /outbox_flush/, 'the queue is drained by delivery.sh, not reimplemented here')
  assert.doesNotMatch(calls[0], /outbox_save/, 'a flush does not add to the queue it drains')
  const argv = calls[0].split(' ')
  assert.equal(argv.at(-2), LIBRARY, 'the library travels as an argv entry')
  assert.equal(argv.at(-1), '3', 'a run is capped at the default batch size')
  assert.match(calls[0], /OUTBOX_FLUSH_MAX=/, 'the cap is handed to delivery.sh, which owns the queue')

  // The cap exists because one inbound message only refreshes one token: on 2026-10-29 a
  // ten-message burst spent it after the ninth, and everything after answered http502.
  const wide = []
  await flush({
    library: LIBRARY,
    max: 1,
    exec: async (file, args) => {
      wide.push(args.join(' '))
      return { stdout: 'ok\n' }
    },
  })
  assert.equal(wide[0].split(' ').at(-1), '1', '--max N reaches delivery.sh as the batch size')

  const pending = await flush({
    library: LIBRARY,
    exec: async () => {
      const error = new Error('exit 1')
      error.stdout = 'OUTBOX 暂停补发 3 条：距用户最后一条微信消息 71.2h\n'
      throw error
    },
  })
  assert.equal(pending.status, 'pending', 'a backlog is a status, not an exception')
  assert.match(pending.detail, /71\.2h/, 'the reason delivery.sh gave is carried through')

  assert.equal((await flush({ library: '/nonexistent/delivery.sh' })).status, 'absent', 'no library means no channel, not a fake success')
})
