import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SETTINGS_DEFAULTS, createSettings, decideAutoCollect, normalizeSettings } from '../lib/settings.js'

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
      now: at,
    })

  assert.deepEqual(decide({ settings: { autoCollect: false } }), { ask: false, reason: 'off' })
  assert.deepEqual(decide({ sessionId: '' }), { ask: false, reason: 'no-session' })
  assert.equal(decide({ turnReason: 'aborted' }).reason, 'turn-aborted')
  assert.equal(decide({ turnReason: 'error' }).reason, 'turn-error')
  assert.equal(decide({ recentSessionId: 'session-other' }).reason, 'not-the-users-conversation')
  assert.equal(decide({ recentSessionId: '' }).reason, 'not-the-users-conversation')
  assert.equal(decide({ settings: { asked: { 'session-me': at - 1000 } } }).reason, 'cooldown')
  assert.equal(decide({ settings: { asked: { 'session-me': at - 31 * 60 * 1000 } } }).ask, true)
  assert.deepEqual(decide({}), { ask: true, reason: 'ok' })
})
