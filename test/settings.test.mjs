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
  normalizeSettings,
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
      settings: { ...settings, asked: { 'session-me': now - 60_000 } },
      recentSessionId: 'session-me',
      now,
    }),
    [],
  )

  // A session with no known activity is never due: not knowing is a reason to wait.
  assert.deepEqual(
    dueAutoCollect({ pending: { 'session-me': now }, activityAt: {}, settings, recentSessionId: 'session-me', now }),
    [],
  )
})
