/**
 * Host-side plugin settings, and the decision of when to collect on its own.
 *
 * The panel cannot keep this: "ask the conversation again in half an hour" is a
 * decision the Host makes while the panel may not even be open. So it lives next to
 * the todo file and the panel edits it through a route.
 *
 * @module dsh-global-todo/settings
 */

import { readFile, writeFile } from 'node:fs/promises'

/** How many sessions the cooldown bookkeeping remembers. */
const ASKED_LIMIT = 50

export const SETTINGS_DEFAULTS = Object.freeze({
  /** Ask a conversation to collect todos on its own. Off until a person says so. */
  autoCollect: false,
  /**
   * How long a conversation must have had **no new message** before it is asked.
   *
   * Asking at `turn/end` was the design mistake: a working session ends turns every few
   * minutes, so "anything to follow up on?" arrived while the person was still working.
   */
  idleMinutes: 30,
  /** How long one conversation stays quiet after being asked. */
  cooldownMinutes: 30,
})

/**
 * @param {unknown} raw
 * @returns {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number> }}
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const minutes = Number(source.cooldownMinutes)
  const idle = Number(source.idleMinutes)
  const asked = {}
  const entries = []
  if (source.asked !== null && typeof source.asked === 'object' && !Array.isArray(source.asked)) {
    for (const [sessionId, at] of Object.entries(source.asked)) {
      if (typeof sessionId !== 'string' || sessionId === '' || !Number.isFinite(at)) continue
      entries.push([sessionId, Number(at)])
    }
  }
  // Newest first, so the cap drops the oldest bookkeeping rather than the newest.
  entries.sort((left, right) => right[1] - left[1])
  for (const [sessionId, at] of entries.slice(0, ASKED_LIMIT)) asked[sessionId] = at
  return {
    autoCollect: source.autoCollect === true,
    cooldownMinutes: Number.isInteger(minutes) ? Math.min(Math.max(minutes, 5), 24 * 60) : SETTINGS_DEFAULTS.cooldownMinutes,
    idleMinutes: Number.isInteger(idle) ? Math.min(Math.max(idle, 5), 24 * 60) : SETTINGS_DEFAULTS.idleMinutes,
    asked,
  }
}

/**
 * @param {{ file: string, logger?: object }} options
 */
export function createSettings(options) {
  let state = normalizeSettings(SETTINGS_DEFAULTS)
  // The startup read is kicked off without being awaited (the plugin cannot block its own
  // mount on a file), and it replaces the *whole* state. A write that lands while it is
  // still in flight is therefore undone by it — the panel's toggle would flip back and the
  // cooldown it just booked would vanish. So mutations wait for the read to finish.
  let startup = Promise.resolve()

  const persist = async () => {
    try {
      await writeFile(options.file, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, 'utf8')
    } catch (error) {
      options.logger?.warn?.(`dsh-global-todo: 设置无法写入（${String(error?.message ?? error)}）`)
    }
  }

  return {
    /** Read once at startup; a missing or broken file means the defaults. */
    async load() {
      startup = (async () => {
        try {
          state = normalizeSettings(JSON.parse(await readFile(options.file, 'utf8')))
        } catch {
          state = normalizeSettings(SETTINGS_DEFAULTS)
        }
      })()
      await startup
      return this.get()
    },
    /** @returns {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number> }} */
    get() {
      return { ...state, asked: { ...state.asked } }
    },
    /** A patch a route or a test can send; unknown fields are ignored. */
    async update(patch) {
      await startup
      state = normalizeSettings({ ...state, ...(patch ?? {}) })
      await persist()
      return this.get()
    },
    /** Record that a conversation was asked, so the cooldown starts now. */
    async rememberAsked(sessionId, at) {
      await startup
      if (typeof sessionId !== 'string' || sessionId === '') return this.get()
      state = normalizeSettings({ ...state, asked: { ...state.asked, [sessionId]: at } })
      await persist()
      return this.get()
    },
  }
}

/**
 * Should the Host ask this conversation to collect todos right now?
 *
 * Called on a timer, not on `turn/end`: a session that is still being worked in ends turns
 * constantly, and each one used to produce a question. The gate is now quiet time — no new
 * message for `idleMinutes` — so the question arrives when the person has actually stopped.
 *
 * Split out as a pure function because the interesting part is the list of reasons
 * *not* to ask: an aborted or failed turn, a conversation nobody is in, a session
 * asked recently, or the feature switched off. Every one of them exists to keep the
 * automatic path from becoming noise.
 *
 * @param {object} input
 * @param {{ autoCollect: boolean, cooldownMinutes: number, asked: Record<string, number> }} input.settings
 * @param {string} input.sessionId - the session whose turn just ended
 * @param {string} input.recentSessionId - the conversation the person last wrote in
 * @param {string} [input.turnReason]
 * @param {number} input.now
 * @returns {{ ask: boolean, reason: string }}
 */
/**
 * Which conversations are due to be asked right now.
 *
 * Split from the timer so the rule can be tested without waiting half an hour: the map of
 * last-activity timestamps is the whole input that matters, and it is a plain object.
 *
 * @param {object} input
 * @param {Record<string, number>} input.pending - sessions whose turn ended cleanly
 * @param {Record<string, number>} input.activityAt - last message time per session
 * @param {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number> }} input.settings
 * @param {string} input.recentSessionId
 * @param {number} input.now
 * @returns {{ sessionId: string, idleMs: number }[]}
 */
export function dueAutoCollect(input) {
  const due = []
  for (const sessionId of Object.keys(input.pending ?? {})) {
    const lastAt = input.activityAt?.[sessionId]
    // Fail closed: without a known "went quiet at", there is nothing to wait for.
    if (!Number.isFinite(lastAt) || lastAt <= 0) continue
    const idleMs = input.now - lastAt
    const decision = decideAutoCollect({
      settings: input.settings,
      sessionId,
      recentSessionId: input.recentSessionId,
      turnReason: 'completed',
      idleMs,
      now: input.now,
    })
    if (decision.ask) due.push({ sessionId, idleMs })
  }
  return due
}

/**
 * Candidates whose conversation has been quiet long enough, ignoring the switch.
 *
 * Separate from `dueAutoCollect` because ticking off finished work is not the same feature as
 * asking for more: the first should happen whether or not the second is switched on.
 *
 * @param {{ pending: Record<string, number>, activityAt: Record<string, number>, idleMinutes: number, now: number }} input
 * @returns {string[]}
 */
export function idleSessions(input) {
  const required = (Number.isFinite(input.idleMinutes) ? input.idleMinutes : 30) * 60 * 1000
  const out = []
  for (const sessionId of Object.keys(input.pending ?? {})) {
    const lastAt = input.activityAt?.[sessionId]
    if (!Number.isFinite(lastAt) || lastAt <= 0) continue
    if (input.now - lastAt >= required) out.push(sessionId)
  }
  return out
}

export function decideAutoCollect(input) {
  if (input.settings.autoCollect !== true) return { ask: false, reason: 'off' }
  if (typeof input.sessionId !== 'string' || input.sessionId === '') return { ask: false, reason: 'no-session' }
  if (input.turnReason !== 'completed') return { ask: false, reason: `turn-${input.turnReason ?? 'unknown'}` }
  // Only where a person actually is: a hand-off, a subagent or a background run must
  // not be interrupted with "anything to follow up on?".
  if (input.recentSessionId === '' || input.sessionId !== input.recentSessionId) {
    return { ask: false, reason: 'not-the-users-conversation' }
  }
  // Quiet first: the clock restarts on every message, so a busy session is never asked.
  // Fail closed: not knowing how long it has been quiet is a reason to wait, not to ask.
  const idleMs = Number.isFinite(input.idleMs) ? input.idleMs : 0
  const requiredMs = (input.settings.idleMinutes ?? 30) * 60 * 1000
  if (idleMs < requiredMs) return { ask: false, reason: 'not-idle-yet' }
  const last = input.settings.asked[input.sessionId]
  const cooldownMs = input.settings.cooldownMinutes * 60 * 1000
  if (Number.isFinite(last) && input.now - last < cooldownMs) return { ask: false, reason: 'cooldown' }
  return { ask: true, reason: 'ok' }
}
