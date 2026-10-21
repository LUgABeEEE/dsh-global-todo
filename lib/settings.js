/**
 * Host-side plugin settings, and the decision of when to collect on its own.
 *
 * The panel cannot keep this: "ask the conversation again in half an hour" is a
 * decision the Host makes while the panel may not even be open. So it lives next to
 * the todo file and the panel edits it through a route.
 *
 * @module dsh-global-todo/settings
 */

import { chmod, readFile } from 'node:fs/promises'
import { isAbsolutePath } from './links.js'
import { atomicWrite } from './store.js'

/** How many sessions the cooldown bookkeeping remembers. */
const ASKED_LIMIT = 50

/**
 * Backoff after a failed question, in order. A failed resume is often transient, so the
 * first retry is a minute away; three failures mean the conversation is not reachable now.
 */
export const RETRY_DELAYS_MS = Object.freeze([60_000, 300_000, 1_500_000])

/**
 * @param {number} attempts - 1-based failure count
 * @returns {number} milliseconds to wait before the next attempt
 */
export function retryDelayMs(attempts) {
  const index = Math.min(Math.max(Number(attempts) || 1, 1), RETRY_DELAYS_MS.length) - 1
  return RETRY_DELAYS_MS[index]
}

/** How many exempt workspaces are remembered. */
const EXEMPT_LIMIT = 50

/**
 * Where an external item may come from. An ingest request with a kind outside this list is
 * refused rather than filed under "unknown": provenance the list cannot name is provenance it
 * cannot reason about later.
 */
export const INGEST_SOURCES = Object.freeze(['mail', 'notification', 'announcement'])

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
  /**
   * Working directories whose conversations are never asked. Empty until a person says so.
   *
   * A whole directory rather than one conversation, because the conversations that need
   * this are the ones a machine drives: a chat companion's session is recreated with a new
   * id whenever it restarts, so an exemption pinned to one id would quietly stop applying.
   * The path is the stable fact about such a place.
   */
  exemptWorkspaces: [],
  /** External ingest is off until a person turns it on and sets a token. */
  ingestEnabled: false,
  /** Bearer token for `/ingest`. Empty refuses every request. Never returned by `/health`. */
  ingestToken: '',
  ingestSources: [...INGEST_SOURCES],
  /** Items below this confidence wait in the inbox instead of joining the list. */
  ingestConfirmBelow: 0.8,
  /** Announce deadlines in the panel. On by default; a deadline nobody hears about is just data. */
  remindersEnabled: true,
  /** Announce this many minutes before the deadline (0 = at the deadline). */
  reminderLeadMinutes: 0,
})

/**
 * @param {unknown} raw
 * @returns {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number>, exemptWorkspaces: string[] }}
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
  // Trailing separators come off so `/x/` and `/x` (or `C:\\x\\` and `C:\\x`) cannot both be
  // listed and both match. Windows workspaces are drive or UNC paths, so the test is
  // `isAbsolutePath`, not "starts with a slash" — the latter silently rejected every
  // exempt workspace a Windows user configured.
  const exemptWorkspaces = []
  for (const entry of Array.isArray(source.exemptWorkspaces) ? source.exemptWorkspaces : []) {
    if (typeof entry !== 'string') continue
    const dir = entry.trim().replace(/[\\/]+$/, '')
    // A relative path would match by accident; an exemption has to name a place.
    if (dir === '' || !isAbsolutePath(dir)) continue
    // Windows paths are case-insensitive, so `C:\\Dev` and `c:\\dev` are one place.
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (exemptWorkspaces.some((listed) => (process.platform === 'win32' ? listed.toLowerCase() : listed) === key)) continue
    if (exemptWorkspaces.length >= EXEMPT_LIMIT) break
    exemptWorkspaces.push(dir)
  }
  const sources = []
  for (const entry of Array.isArray(source.ingestSources) ? source.ingestSources : []) {
    if (typeof entry !== 'string') continue
    const kind = entry.trim().toLowerCase()
    if (!INGEST_SOURCES.includes(kind) || sources.includes(kind)) continue
    sources.push(kind)
  }
  const below = Number(source.ingestConfirmBelow)
  const lead = Number(source.reminderLeadMinutes)
  return {
    autoCollect: source.autoCollect === true,
    cooldownMinutes: Number.isInteger(minutes) ? Math.min(Math.max(minutes, 5), 24 * 60) : SETTINGS_DEFAULTS.cooldownMinutes,
    idleMinutes: Number.isInteger(idle) ? Math.min(Math.max(idle, 5), 24 * 60) : SETTINGS_DEFAULTS.idleMinutes,
    asked,
    exemptWorkspaces,
    ingestEnabled: source.ingestEnabled === true,
    // A token is opaque: no shape rule beyond "not empty", trimmed and capped so a pasted
    // blob cannot become the whole settings file.
    ingestToken: typeof source.ingestToken === 'string' ? source.ingestToken.trim().slice(0, 512) : '',
    ingestSources: sources.length === 0 ? [...INGEST_SOURCES] : sources,
    ingestConfirmBelow: Number.isFinite(below) ? Math.min(Math.max(below, 0), 1) : SETTINGS_DEFAULTS.ingestConfirmBelow,
    remindersEnabled: source.remindersEnabled !== false,
    reminderLeadMinutes: Number.isFinite(lead) ? Math.min(Math.max(lead, 0), 24 * 60) : SETTINGS_DEFAULTS.reminderLeadMinutes,
  }
}

/**
 * Is this conversation inside a workspace nobody wants asked?
 *
 * Subdirectories count: a conversation started below the exempted directory is still in
 * the place the exemption is about.
 *
 * @param {string} sessionDir
 * @param {string[]} exemptWorkspaces
 * @returns {boolean}
 */
export function isExemptWorkspace(sessionDir, exemptWorkspaces) {
  if (typeof sessionDir !== 'string' || sessionDir === '') return false
  const dir = sessionDir.replace(/\/+$/, '')
  return (Array.isArray(exemptWorkspaces) ? exemptWorkspaces : []).some(
    (root) => typeof root === 'string' && root !== '' && (dir === root || dir.startsWith(`${root}/`)),
  )
}

/**
 * @param {{ file: string, logger?: object }} options
 */
export function createSettings(options) {
  let state = normalizeSettings(SETTINGS_DEFAULTS)
  // How the file arrived. An off switch and a broken file look identical from the panel,
  // and that ambiguity is exactly what made a silent failure to load invisible.
  let loadInfo = { file: options.file ?? '', source: 'default', at: 0, error: null }
  // The startup read is kicked off without being awaited (the plugin cannot block its own
  // mount on a file), and it replaces the *whole* state. A write that lands while it is
  // still in flight is therefore undone by it — the panel's toggle would flip back and the
  // cooldown it just booked would vanish. So mutations wait for the read to finish.
  let startup = Promise.resolve()

  const persist = async () => {
    try {
      // Same atomic path as the todo file: a half-written settings file on Windows (the
      // kind a crash or a locked rename leaves behind) would silently reset every switch.
      await atomicWrite(options.file, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
      // The file can hold an ingest token; keep it readable by the Host user only. Best-effort:
      // a filesystem without POSIX modes must not fail the write.
      await chmod(options.file, 0o600).catch(() => {})
    } catch (error) {
      options.logger?.warn?.(`dsh-global-todo: 设置无法写入（${String(error?.message ?? error)}）`)
    }
  }

  return {
    /** Read once at startup; a missing or broken file means the defaults. */
    async load() {
      startup = (async () => {
        let text = null
        try {
          text = await readFile(options.file, 'utf8')
        } catch (error) {
          state = normalizeSettings(SETTINGS_DEFAULTS)
          loadInfo = {
            file: options.file ?? '',
            source: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
            at: Date.now(),
            error: error?.code === 'ENOENT' ? null : String(error?.message ?? error),
          }
          return
        }
        try {
          state = normalizeSettings(JSON.parse(text))
          loadInfo = { file: options.file ?? '', source: 'file', at: Date.now(), error: null }
        } catch (error) {
          state = normalizeSettings(SETTINGS_DEFAULTS)
          loadInfo = { file: options.file ?? '', source: 'corrupt', at: Date.now(), error: String(error?.message ?? error) }
        }
      })()
      await startup
      return this.get()
    },
    /** @returns {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number>, exemptWorkspaces: string[] }} */
    get() {
      return { ...state, asked: { ...state.asked } }
    },
    /** Where the settings came from and whether the file was readable, for /health. */
    info() {
      return { ...loadInfo }
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
    /**
     * Undo a booking whose question never arrived.
     *
     * A failed ask used to leave the booking behind, and `awaiting-human` then kept the
     * conversation silent until a person spoke again — one transient resume failure turned
     * the feature off for that conversation.
     */
    async forgetAsked(sessionId) {
      await startup
      if (typeof sessionId !== 'string' || sessionId === '' || !(sessionId in state.asked)) return this.get()
      const asked = { ...state.asked }
      delete asked[sessionId]
      state = normalizeSettings({ ...state, asked })
      await persist()
      return this.get()
    },
  }
}

/**
 * Which conversations are due to be asked right now.
 *
 * Split from the timer so the rule can be tested without waiting half an hour: the map of
 * last-activity timestamps is the whole input that matters, and it is a plain object.
 *
 * @param {object} input
 * @param {Record<string, number>} input.pending - sessions whose turn ended cleanly
 * @param {Record<string, number>} input.activityAt - last message time per session
 * @param {Record<string, number>} [input.humanAt] - when a person last wrote, per session
 * @param {Record<string, string>} [input.dirAt] - working directory per session
 * @param {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number>, exemptWorkspaces: string[] }} input.settings
 * @param {string} input.recentSessionId
 * @param {number} input.now
 * @returns {{ sessionId: string, idleMs: number }[]}
 */
export function dueAutoCollect(input) {
  return explainAutoCollect(input)
    .filter((decision) => decision.ask)
    .map((decision) => ({ sessionId: decision.sessionId, idleMs: decision.idleMs }))
}

/**
 * The same decisions, with the reason kept.
 *
 * `dueAutoCollect` used to compute the reason and throw it away, which is why "why was this
 * conversation not asked?" had no answer anywhere. `/health` reads this list.
 *
 * @param {object} input - the same shape `dueAutoCollect` takes, plus optional `retryAt`
 * @returns {{ sessionId: string, ask: boolean, reason: string, idleMs: number }[]}
 */
export function explainAutoCollect(input) {
  const out = []
  for (const sessionId of Object.keys(input.pending ?? {})) {
    const lastAt = input.activityAt?.[sessionId]
    // Fail closed: without a known "went quiet at", there is nothing to wait for.
    if (!Number.isFinite(lastAt) || lastAt <= 0) {
      out.push({ sessionId, ask: false, reason: 'no-activity', idleMs: 0 })
      continue
    }
    const idleMs = input.now - lastAt
    const decision = decideAutoCollect({
      settings: input.settings,
      sessionId,
      recentSessionId: input.recentSessionId,
      turnReason: 'completed',
      idleMs,
      humanAt: input.humanAt,
      sessionDir: input.dirAt?.[sessionId],
      retryAt: input.retryAt,
      now: input.now,
    })
    out.push({ sessionId, idleMs, ask: decision.ask, reason: decision.reason })
  }
  return out
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

/**
 * Should the Host ask this conversation to collect todos right now?
 *
 * Called on a timer, not on `turn/end`: a session that is still being worked in ends turns
 * constantly, and each one used to produce a question. The gate is quiet time — no new
 * message for `idleMinutes` — so the question arrives when the person has actually stopped.
 *
 * Split out as a pure function because the interesting part is the list of reasons *not* to
 * ask: an aborted or failed turn, a conversation nobody is in, a conversation in a workspace
 * somebody exempted, one already asked with no answer since, one asked too recently, or the
 * feature switched off. Every one of them exists to keep the automatic path from becoming
 * noise.
 *
 * @param {object} input
 * @param {{ autoCollect: boolean, idleMinutes: number, cooldownMinutes: number, asked: Record<string, number>, exemptWorkspaces: string[] }} input.settings
 * @param {string} input.sessionId
 * @param {string} input.recentSessionId
 * @param {string} [input.turnReason]
 * @param {number} [input.idleMs]
 * @param {Record<string, number>} [input.humanAt] - when a person last wrote, per session
 * @param {string} [input.sessionDir] - the conversation's working directory, when known
 * @param {Record<string, number>} [input.retryAt] - next retry time per session after a failure
 * @param {number} input.now
 * @returns {{ ask: boolean, reason: string }}
 */
export function decideAutoCollect(input) {
  if (input.settings.autoCollect !== true) return { ask: false, reason: 'off' }
  if (typeof input.sessionId !== 'string' || input.sessionId === '') return { ask: false, reason: 'no-session' }
  // An exempted workspace is decided before anything about the conversation's state: the
  // answer does not depend on how quiet it is, and a check that cannot tell whether the
  // exemption is deployed would read a missing reason as a broken rule.
  if (isExemptWorkspace(input.sessionDir ?? '', input.settings.exemptWorkspaces)) {
    return { ask: false, reason: 'exempt-workspace' }
  }
  // Fail closed on an unknown directory. The exemption is keyed on where the conversation
  // works, and a place nobody can name cannot be checked against it -- asking there would
  // volunteer a question where the person may well have meant to exclude. The cost is a
  // conversation whose cwd the Host never reported, and the event tracker normally supplies
  // it on the first message.
  if (typeof input.sessionDir !== 'string' || input.sessionDir === '') {
    return { ask: false, reason: 'unknown-dir' }
  }
  if (input.turnReason !== 'completed') return { ask: false, reason: `turn-${input.turnReason ?? 'unknown'}` }
  // Only where a person actually is: a hand-off, a subagent or a background run must
  // not be interrupted with "anything to follow up on?".
  if (input.recentSessionId === '' || input.sessionId !== input.recentSessionId) {
    return { ask: false, reason: 'not-the-users-conversation' }
  }
  // A failed question backs off instead of retrying on the next tick. The booking is cleared
  // on failure (see index.js), so without this the retry would be immediate.
  const retryAt = input.retryAt?.[input.sessionId]
  if (Number.isFinite(retryAt) && retryAt > input.now) return { ask: false, reason: 'retry-wait' }
  // One question per person-turn — and the rule that ends the loop.
  //
  // The question is itself a message in the conversation: it restarted the quiet clock
  // below, and its own answer ended a clean turn, which re-marked the conversation as a
  // candidate. With `cooldownMinutes` on the same half hour as `idleMinutes` the cooldown
  // had always expired by the time the quiet gate opened, so the same conversation was
  // asked again and again for as long as nobody touched it. Only a message a *person* typed
  // re-arms it; the plugin's own traffic never does.
  const last = input.settings.asked[input.sessionId]
  if (Number.isFinite(last)) {
    const humanAt = input.humanAt?.[input.sessionId]
    // No answer since the question means quiet, however long that lasts. A restarted Host
    // has forgotten the timestamps and so stays quiet too — the safe direction.
    if (!(Number.isFinite(humanAt) && humanAt > last)) return { ask: false, reason: 'awaiting-human' }
  }
  // Quiet first: the clock restarts on every message, so a busy session is never asked.
  // Fail closed: not knowing how long it has been quiet is a reason to wait, not to ask.
  const idleMs = Number.isFinite(input.idleMs) ? input.idleMs : 0
  const requiredMs = (input.settings.idleMinutes ?? 30) * 60 * 1000
  if (idleMs < requiredMs) return { ask: false, reason: 'not-idle-yet' }
  const cooldownMs = input.settings.cooldownMinutes * 60 * 1000
  if (Number.isFinite(last) && input.now - last < cooldownMs) return { ask: false, reason: 'cooldown' }
  return { ask: true, reason: 'ok' }
}
