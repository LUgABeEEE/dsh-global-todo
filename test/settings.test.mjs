import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SETTINGS_DEFAULTS,
  createSettings,
  decideAutoCollect,
  dueAutoCollect,
  explainAutoCollect,
  normalizeSettings,
  retryDelayMs,
} from '../lib/settings.js'

test('settings default to off, and every field is repaired rather than trusted', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...SETTINGS_DEFAULTS, asked: {} })
  assert.deepEqual(normalizeSettings('nonsense'), { ...SETTINGS_DEFAULTS, asked: {} })
  // Out-of-range cooldowns are clamped: five minutes is the floor, a day the ceiling.
  assert.equal(normalizeSettings({ cooldownMinutes: 1 }).cooldownMinutes, 5)
  assert.equal(normalizeSettings({ cooldownMinutes: 99999 }).cooldownMinutes, 1440)
  assert.equal(normalizeSettings({ cooldownMinutes: 12.7 }).cooldownMinutes, SETTINGS_DEFAULTS.cooldownMinutes)
  // `autoCollect` is only true when it is exactly true.
  assert.equal(normalizeSettings({ autoCollect: 'yes' }).autoCollect, false)
  assert.equal(normalizeSettings({ autoCollect: true }).autoCollect, true)
})

test('the exempt workspace list is repaired rather than trusted', () => {
  // A trailing slash comes off, so one place cannot be listed twice; a relative path is not
  // a place at all, and matching one by accident would silence a conversation nobody named.
  assert.deepEqual(
    normalizeSettings({ exemptWorkspaces: ['/a/', '/a', '/b', 'relative', '', 7, '/a/sub'] }).exemptWorkspaces,
    ['/a', '/b', '/a/sub'],
  )
  assert.deepEqual(normalizeSettings({ exemptWorkspaces: 'nope' }).exemptWorkspaces, [])
  assert.deepEqual(normalizeSettings({}).exemptWorkspaces, [])
})

test('the sync directory is a place or nothing, and the interval keeps zero', () => {
  // Absolute only: a relative path would resolve against the Host's cwd, and two machines
  // would silently meet in two different directories.
  assert.equal(normalizeSettings({ syncDir: '/mnt/nas/todo' }).syncDir, '/mnt/nas/todo')
  assert.equal(normalizeSettings({ syncDir: '/mnt/nas/todo/' }).syncDir, '/mnt/nas/todo')
  assert.equal(normalizeSettings({ syncDir: '  /mnt/nas/todo  ' }).syncDir, '/mnt/nas/todo')
  assert.equal(normalizeSettings({ syncDir: 'relative/dir' }).syncDir, '')
  assert.equal(normalizeSettings({ syncDir: 42 }).syncDir, '')
  // A drive root keeps its separator: stripping it would turn "C:\" into a relative "C:".
  assert.equal(normalizeSettings({ syncDir: 'C:\\' }).syncDir, 'C:\\')
  // A UNC share is a place too, which is how a Windows machine reaches the NAS.
  assert.equal(normalizeSettings({ syncDir: '\\\\nas\\share\\todo' }).syncDir, '\\\\nas\\share\\todo')
  // 0 is a real value here — "only when asked" — so it must not be replaced by the default.
  assert.equal(normalizeSettings({ syncMinutes: 0 }).syncMinutes, 0)
  assert.equal(normalizeSettings({ syncMinutes: 7.6 }).syncMinutes, 8)
  assert.equal(normalizeSettings({ syncMinutes: 99999 }).syncMinutes, 1440)
  assert.equal(normalizeSettings({ syncMinutes: 'nope' }).syncMinutes, SETTINGS_DEFAULTS.syncMinutes)
  assert.equal(SETTINGS_DEFAULTS.syncDir, '', 'a machine is on its own until somebody says otherwise')
})

test('the cooldown bookkeeping keeps the newest sessions and drops junk', () => {
  const asked = { junk: 'nope', '': 5, 'session-old': 1, 'session-new': 100 }
  for (let index = 0; index < 80; index += 1) asked[`session-${index}`] = index
  const normalized = normalizeSettings({ asked })
  const kept = Object.keys(normalized.asked)
  assert.ok(kept.length <= 50, `at most 50 sessions are remembered, got ${kept.length}`)
  assert.equal(normalized.asked.junk, undefined)
  assert.equal(normalized.asked[''], undefined)
  assert.equal(normalized.asked['session-new'], 100, 'the newest entry survives the cap')
})

test('settings round-trip through the file, and defaults survive a broken one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-settings-'))
  const file = path.join(dir, 'settings.json')
  try {
    const settings = createSettings({ file })
    await settings.load()
    assert.equal(settings.get().autoCollect, false, 'a missing file means off')

    await settings.update({ autoCollect: true, cooldownMinutes: 45 })
    assert.equal(settings.get().autoCollect, true)
    assert.equal(settings.get().cooldownMinutes, 45)
    const written = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(written.autoCollect, true)
    assert.equal(written.version, 1)

    // A second instance reads what the first one wrote.
    const reopened = createSettings({ file })
    await reopened.load()
    assert.equal(reopened.get().cooldownMinutes, 45)

    // A corrupt file falls back instead of throwing.
    await writeFile(file, '{ not json', 'utf8')
    const broken = createSettings({ file })
    await broken.load()
    assert.equal(broken.get().autoCollect, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed question can be unbooked, and the file says how it loaded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-settings-info-'))
  const file = path.join(dir, 'settings.json')
  try {
    const missing = createSettings({ file })
    await missing.load()
    assert.equal(missing.info().source, 'missing', 'a first run is not a corrupt file')
    assert.equal(missing.info().error, null)

    await writeFile(file, JSON.stringify({ version: 1, autoCollect: true }), 'utf8')
    const loaded = createSettings({ file })
    await loaded.load()
    assert.equal(loaded.info().source, 'file')
    assert.equal(loaded.get().autoCollect, true)

    // The failure path: a question was booked, the ask failed, and the booking must go —
    // otherwise `awaiting-human` keeps the conversation quiet until a person speaks.
    await loaded.rememberAsked('session-me', 1_000)
    assert.equal(loaded.get().asked['session-me'], 1_000)
    await loaded.forgetAsked('session-me')
    assert.equal(loaded.get().asked['session-me'], undefined)
    const reopened = createSettings({ file })
    await reopened.load()
    assert.equal(reopened.get().asked['session-me'], undefined, 'the unbooking reached the disk')

    await writeFile(file, '{ not json', 'utf8')
    const corrupt = createSettings({ file })
    await corrupt.load()
    assert.equal(corrupt.info().source, 'corrupt')
    assert.ok(corrupt.info().error.length > 0, 'a broken file has to name why it fell back')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('retry delays back off, and a scheduled retry is a named reason', () => {
  assert.equal(retryDelayMs(1), 60_000)
  assert.equal(retryDelayMs(2), 300_000)
  assert.equal(retryDelayMs(3), 1_500_000)
  assert.equal(retryDelayMs(99), 1_500_000, 'the backoff stays capped')
  assert.equal(retryDelayMs(0), 60_000, 'a junk count means the first delay, not none')

  const settings = { ...SETTINGS_DEFAULTS, autoCollect: true, asked: {} }
  const at = 1_000_000
  const decide = (over = {}) =>
    decideAutoCollect({
      settings,
      sessionId: 'session-me',
      recentSessionId: 'session-me',
      turnReason: 'completed',
      sessionDir: '/repo',
      idleMs: 60 * 60 * 1000,
      now: at,
      ...over,
    })
  assert.equal(decide({ retryAt: { 'session-me': at + 1 } }).reason, 'retry-wait')
  assert.equal(decide({ retryAt: { 'session-me': at - 1 } }).ask, true)

  // The decision list keeps the reason and the quiet time: /health used to have neither.
  const decisions = explainAutoCollect({
    pending: { 'session-me': at - 120_000, 'session-other': at - 120_000 },
    activityAt: { 'session-me': at - 60_000 },
    dirAt: { 'session-me': '/repo', 'session-other': '/repo' },
    settings,
    recentSessionId: 'session-me',
    now: at,
  })
  assert.deepEqual(
    decisions.map((decision) => [decision.sessionId, decision.reason]),
    [
      ['session-me', 'not-idle-yet'],
      ['session-other', 'no-activity'],
    ],
  )
  assert.equal(decisions[0].idleMs, 60_000, 'the quiet time is reported, not just the verdict')
})

test('a write that lands while the startup read is in flight is not undone by it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-settings-startup-'))
  const file = path.join(dir, 'settings.json')
  try {
    const settings = createSettings({ file })
    // Exactly what the plugin does at mount: start the read, do not await it, and let a
    // panel write arrive. The read replaces the whole state, so a write that lands first
    // used to be silently undone by the read finishing second.
    const loading = settings.load()
    const updated = await settings.update({ autoCollect: true })
    assert.equal(updated.autoCollect, true, 'the write must survive the startup read')
    await loading
    assert.equal(settings.get().autoCollect, true, 'the read must not undo the write')

    const reopened = createSettings({ file })
    await reopened.load()
    assert.equal(reopened.get().autoCollect, true, 'and the write reached the disk')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the automatic collect decision names why it stays quiet', () => {
  const base = { ...SETTINGS_DEFAULTS, asked: {} }
  const at = 1_000_000
  const decide = (over = {}) =>
    decideAutoCollect({
      settings: { ...base, autoCollect: true, ...(over.settings ?? {}) },
      sessionId: over.sessionId ?? 'session-me',
      recentSessionId: over.recentSessionId ?? 'session-me',
      turnReason: over.turnReason ?? 'completed',
      humanAt: over.humanAt,
      // A known directory by default: an unknown one is now its own reason to stay quiet.
      sessionDir: over.sessionDir ?? '/repo',
      // Quiet long enough unless a test says otherwise.
      idleMs: over.idleMs ?? 60 * 60 * 1000,
      now: at,
    })

  assert.deepEqual(decide({ settings: { autoCollect: false } }), { ask: false, reason: 'off' })
  assert.deepEqual(decide({ sessionId: '' }), { ask: false, reason: 'no-session' })
  assert.equal(decide({ turnReason: 'aborted' }).reason, 'turn-aborted')
  assert.equal(decide({ turnReason: 'error' }).reason, 'turn-error')
  assert.equal(decide({ recentSessionId: 'session-other' }).reason, 'not-the-users-conversation')
  assert.equal(decide({ recentSessionId: '' }).reason, 'not-the-users-conversation')
  // Asked with nobody answering: quiet for as long as it takes. This is the rule that ends
  // the loop the plugin's own question used to drive — the question is a message in the
  // conversation, so without it the same conversation was asked again every half hour.
  assert.equal(decide({ settings: { asked: { 'session-me': at - 1000 } } }).reason, 'awaiting-human')
  assert.equal(decide({ settings: { asked: { 'session-me': at - 31 * 60 * 1000 } } }).reason, 'awaiting-human')
  // A person writing *after* the question re-arms it, and the ordinary timing rules apply
  // again: too soon is still too soon, long enough is a yes.
  const answered = (askedAgo) => ({
    settings: { asked: { 'session-me': at - askedAgo } },
    humanAt: { 'session-me': at - Math.floor(askedAgo / 2) },
  })
  assert.equal(decide(answered(1000)).reason, 'cooldown')
  assert.equal(decide(answered(31 * 60 * 1000)).ask, true)
  // A person who wrote *before* the question did not answer it, so it stays quiet.
  assert.equal(
    decide({
      settings: { asked: { 'session-me': at - 1000 } },
      humanAt: { 'session-me': at - 5000 },
    }).reason,
    'awaiting-human',
  )
  assert.deepEqual(decide({}), { ask: true, reason: 'ok' })
  // An exempted workspace is settled before anything about the conversation's state, so the
  // reason names the exemption rather than whichever timing rule happened to apply.
  const exempted = { exemptWorkspaces: ['/home/me/workspace/示例工作区'] }
  assert.equal(decide({ settings: exempted, sessionDir: '/home/me/workspace/示例工作区' }).reason, 'exempt-workspace')
  assert.equal(
    decide({ settings: exempted, sessionDir: '/home/me/workspace/示例工作区/nested' }).reason,
    'exempt-workspace',
  )
  // A shared prefix is a different place, and an unknown directory is never asked at all:
  // a place nobody can name cannot be checked against an exemption, so the safe answer is
  // silence. The event tracker normally reports the cwd on the first message.
  assert.equal(decide({ settings: exempted, sessionDir: '/home/me/workspace/示例工作区2' }).ask, true)
  assert.equal(decide({ settings: exempted, sessionDir: '' }).reason, 'unknown-dir')
  // The rule asked for: a conversation still being worked in is never asked, and not knowing
  // how long it has been quiet counts as "not yet".
  assert.equal(decide({ idleMs: 29 * 60 * 1000 }).reason, 'not-idle-yet')
  assert.equal(decide({ idleMs: 30 * 60 * 1000 }).ask, true)
  assert.equal(
    decideAutoCollect({
      settings: { ...base, autoCollect: true },
      sessionId: 'session-me',
      recentSessionId: 'session-me',
      turnReason: 'completed',
      sessionDir: '/repo',
      // No idle information at all: fail closed rather than ask.
      now: at,
    }).reason,
    'not-idle-yet',
  )
  assert.equal(decide({ idleMs: 60 * 60 * 1000, settings: { idleMinutes: 90 } }).reason, 'not-idle-yet')
  assert.equal(decide({ idleMs: 90 * 60 * 1000, settings: { idleMinutes: 90 } }).ask, true)
})

test('only a conversation that has gone quiet is due', () => {
  const settings = { ...SETTINGS_DEFAULTS, autoCollect: true, idleMinutes: 30, asked: {} }
  const now = 1_000_000_000

  // Still being worked in: nothing due, however many turns ended.
  assert.deepEqual(
    dueAutoCollect({
      pending: { 'session-me': now - 60_000 },
      activityAt: { 'session-me': now - 60_000 },
      dirAt: { 'session-me': '/repo' },
      settings,
      recentSessionId: 'session-me',
      now,
    }),
    [],
  )

  // Quiet for half an hour: due — and the idle time is reported, so the log says why.
  assert.deepEqual(
    dueAutoCollect({
      pending: { 'session-me': now - 31 * 60_000 },
      activityAt: { 'session-me': now - 31 * 60_000 },
      dirAt: { 'session-me': '/repo' },
      settings,
      recentSessionId: 'session-me',
      now,
    }),
    [{ sessionId: 'session-me', idleMs: 31 * 60_000 }],
  )

  // Someone else's conversation, or one already asked inside the cooldown, stays quiet.
  assert.deepEqual(
    dueAutoCollect({
      pending: { 'session-other': now - 31 * 60_000 },
      activityAt: { 'session-other': now - 31 * 60_000 },
      dirAt: { 'session-other': '/repo' },
      settings,
      recentSessionId: 'session-me',
      now,
    }),
    [],
  )
  assert.deepEqual(
    dueAutoCollect({
      pending: { 'session-me': now - 31 * 60_000 },
      activityAt: { 'session-me': now - 31 * 60_000 },
      dirAt: { 'session-me': '/repo' },
      settings: { ...settings, asked: { 'session-me': now - 60_000 } },
      recentSessionId: 'session-me',
      now,
    }),
    [],
  )

  // A session with no known activity is never due: not knowing is a reason to wait.
  assert.deepEqual(
    dueAutoCollect({ pending: { 'session-me': now }, activityAt: {}, dirAt: { 'session-me': '/repo' }, settings, recentSessionId: 'session-me', now }),
    [],
  )

  // An unknown working directory is never due either: the exemption cannot be checked.
  assert.deepEqual(
    dueAutoCollect({
      pending: { 'session-me': now - 31 * 60_000 },
      activityAt: { 'session-me': now - 31 * 60_000 },
      settings,
      recentSessionId: 'session-me',
      now,
    }),
    [],
    'an unknown directory is not a place to volunteer a question',
  )
})

test('the capture weight threshold defaults and clamps', () => {
  assert.equal(SETTINGS_DEFAULTS.captureMinWeight, 0.35)
  assert.equal(normalizeSettings({}).captureMinWeight, 0.35)
  assert.equal(normalizeSettings({ captureMinWeight: 2 }).captureMinWeight, 1)
  assert.equal(normalizeSettings({ captureMinWeight: -1 }).captureMinWeight, 0)
  assert.equal(normalizeSettings({ captureMinWeight: '0.6' }).captureMinWeight, 0.6)
  assert.equal(normalizeSettings({ captureMinWeight: 'nope' }).captureMinWeight, 0.35)
})

test('a second load must not undo a write that has not been persisted yet', async () => {
  // The failure this encodes: two effects at mount both call load() (the settings reader and the
  // 0.22.0 gate migration). load() replaces the whole state, so when the second read landed after
  // a panel write had changed the state in memory but before it had persisted, the old file came
  // back — the toggle somebody just flipped silently returned to off, and the automatic question
  // never fired. One read per process; after that the only writer is the serialized mutation.
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-settings-reload-'))
  const file = path.join(dir, 'settings.json')
  try {
    const settings = createSettings({ file })
    await settings.load()

    // The invariant that makes the race impossible: the file is read once. A second mount-time
    // call must answer from memory, not re-read — a re-read is what clobbered a write that had
    // changed the state but had not finished persisting.
    await writeFile(file, JSON.stringify({ version: 1, autoCollect: true, gateMigratedAt: 999 }), 'utf8')
    const again = await settings.load()
    assert.equal(again.autoCollect, false, 'a second load must not adopt a file it did not write')
    assert.equal(again.gateMigratedAt, 0)

    // ...and a write after it still lands, in memory and on disk.
    await settings.update({ autoCollect: true, gateMigratedAt: 1234 })
    assert.equal(settings.get().autoCollect, true)
    assert.equal(settings.get().gateMigratedAt, 1234)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.autoCollect, true, 'and so did the file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('interleaved settings writes keep both fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-settings-race-'))
  const file = path.join(dir, 'settings.json')
  try {
    const settings = createSettings({ file })
    await settings.load()
    const writers = []
    for (let index = 0; index < 10; index += 1) {
      writers.push(settings.update({ autoCollect: true }))
      writers.push(settings.update({ gateMigratedAt: 1000 + index }))
    }
    await Promise.all(writers)
    assert.equal(settings.get().autoCollect, true)
    assert.equal(settings.get().gateMigratedAt, 1009)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.autoCollect, true, 'what is on disk matches what the memory says')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
