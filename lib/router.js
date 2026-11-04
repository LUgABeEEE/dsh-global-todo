/**
 * The router tick: one pass that turns the list into "today's three", once a day.
 *
 * This is the piece the Super-agent architecture called a Router, implemented at the size this
 * deployment actually needs: no resident session, no model call, no second process. The
 * decision is rules (triage + gate), the output is a short list, and the only write it makes
 * is a note on the record — the same trail a person or an agent would leave.
 *
 * Two properties matter more than cleverness:
 *
 *  - **Idempotent without state.** Whether today's note exists is answered by the record's own
 *    notes, not by a file this module keeps. A restart re-runs the tick and writes nothing new;
 *    the other machine, folding the same list, reaches the same answer.
 *  - **Observe means observe.** The tick records what the gate *would* allow and never calls
 *    the dispatcher. Turning that on is a separate decision with its own budget.
 *
 * @module dsh-global-todo/router
 */

import { dayKey, normalizePolicy, planDispatch } from './gate.js'
import { TRIAGE_MARK, WATCHDOG_MARK } from './marks.js'
import { BUCKET_LABELS, TOP_COUNT, buildTriage } from './triage.js'
import { findStalled } from './watchdog.js'

/**
 * Marks written into a note. They are the ledger.
 *
 * A prefix rather than a side file because a note replicates through the existing sync and is
 * visible in the panel — a bookkeeping file would be a second truth nobody reads.
 */
export { TRIAGE_MARK }
export { WATCHDOG_MARK }

/**
 * How long before the same record may be announced again.
 *
 * Daily re-announcement of an unchanged record is how a triage list becomes noise; a week is
 * long enough to be quiet and short enough that a record which comes back is noticed.
 */
export const NOTE_REPEAT_DAYS = 7

const DAY_PATTERN = /(\d{4}-\d{2}-\d{2})/

/**
 * The calendar day a marked note was written for, or `''`.
 *
 * @param {string} text
 * @returns {string}
 */
export function markedDay(text) {
  const match = typeof text === 'string' ? text.match(DAY_PATTERN) : null
  return match === null ? '' : match[1]
}

/**
 * Is this record already carrying this mark, recently enough to stay quiet?
 *
 * @param {object} todo
 * @param {string} mark
 * @param {number} now
 * @param {number} [days]
 * @returns {boolean}
 */
export function hasRecentMark(todo, mark, now, days = NOTE_REPEAT_DAYS) {
  const notes = Array.isArray(todo?.notes) ? todo.notes : []
  const horizon = now - days * 86_400_000
  return notes.some((note) => {
    const text = typeof note?.text === 'string' ? note.text : ''
    if (!text.startsWith(mark)) return false
    if (mark === WATCHDOG_MARK) {
      // One announcement per hand-off, not per day: a note older than this dispatch is about
      // an earlier one, and a record that stalls again deserves its own line.
      const sinceAt = Number(todo?.lastDispatch?.at)
      return Number(note?.at) >= (Number.isFinite(sinceAt) ? sinceAt : 0)
    }
    const day = markedDay(text)
    if (day === '') return true
    const at = Date.parse(`${day}T00:00:00`)
    return Number.isFinite(at) && at >= horizon
  })
}

/**
 * The read-only half: everything the panel shows, computed fresh.
 *
 * @param {object[]} todos
 * @param {{ now?: number, policy?: object, top?: number, sessionAlive?: (id: string) => boolean }} [options]
 * @returns {{
 *   generatedAt: number,
 *   triage: ReturnType<typeof buildTriage>,
 *   gate: { budget: object, allowed: object[], refused: object[] },
 *   stalled: object[],
 *   policy: object,
 * }}
 */
export function buildSnapshot(todos, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const policy = normalizePolicy(options.policy)
  const triage = buildTriage(todos, { now, top: options.top ?? TOP_COUNT })
  const gate = planDispatch(todos, { now, policy, sessionAlive: options.sessionAlive })
  const stalled = findStalled(todos, { now, sessionAlive: options.sessionAlive })
  // `denyDirs` stays out of the snapshot: the panel needs the budget numbers, not this
  // machine's home and storage paths echoed back into a page payload.
  return {
    generatedAt: now,
    triage,
    gate,
    stalled,
    policy: { tag: policy.tag, dailyCap: policy.dailyCap, cooldownDays: policy.cooldownDays },
  }
}

/**
 * One tick: the snapshot plus the notes it would write.
 *
 * Returning the notes instead of writing them keeps the decision testable and keeps the write
 * inside `service.note`, which owns the lock. The caller decides whether it is allowed to
 * write at all (the observe/off switch lives in settings, not here).
 *
 * @param {object[]} todos
 * @param {{ now?: number, policy?: object, top?: number, sessionAlive?: (id: string) => boolean }} [options]
 * @returns {{
 *   snapshot: ReturnType<typeof buildSnapshot>,
 *   notes: { id: string, text: string, kind: 'triage' | 'watchdog' }[],
 *   wouldDispatch: object[],
 * }}
 */
export function planTick(todos, options = {}) {
  const snapshot = buildSnapshot(todos, options)
  const now = snapshot.generatedAt
  const byId = new Map()
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (todo !== null && typeof todo === 'object' && typeof todo.id === 'string') byId.set(todo.id, todo)
  }

  const notes = []
  const total = snapshot.triage.today.length
  snapshot.triage.today.forEach((row, index) => {
    const todo = byId.get(row.id)
    if (todo === undefined) return
    if (hasRecentMark(todo, TRIAGE_MARK, now)) return
    const why = row.why.length > 0 ? row.why.join('；') : '没有明显信号'
    notes.push({
      id: row.id,
      kind: 'triage',
      text: `${TRIAGE_MARK} ${dayKey(now)}】今日第 ${index + 1}/${total} 条 · ${BUCKET_LABELS[row.bucket]} —— ${why}`,
    })
  })

  // A stalled hand-off is announced once per hand-off: the note itself is the evidence that
  // somebody was told, and repeating it daily would train the reader to skip it.
  for (const item of snapshot.stalled) {
    const todo = byId.get(item.id)
    if (todo === undefined) continue
    if (hasRecentMark(todo, WATCHDOG_MARK, now)) continue
    notes.push({
      id: item.id,
      kind: 'watchdog',
      text: `${WATCHDOG_MARK} ${dayKey(now)}】派发后 ${item.hours} 小时没有新进展（${item.live ? '会话还在' : '会话已不在'}），不再重试。`,
    })
  }

  // In observe mode this is the answer to "what would have happened", which is the whole point
  // of running the gate before switching it on.
  const wouldDispatch = snapshot.gate.allowed.slice(0, Math.max(0, snapshot.policy.dailyCap - snapshot.gate.budget.used))

  return { snapshot, notes, wouldDispatch }
}


/** Local time the tick is due. 09:45 is the node the guard timer already runs. */
export const TICK_HOUR = 9
export const TICK_MINUTE = 45

/**
 * The gate policy a settings snapshot implies.
 *
 * The tag stays fixed: "可自动" is a promise a person makes in the record, and letting the
 * tag itself be configurable would mean two machines disagreeing about what it says.
 *
 * @param {object} current - a `settings.get()` snapshot
 * @returns {{ tag: string, dailyCap: number, cooldownDays: number }}
 */
export function policyFromSettings(current = {}) {
  return {
    tag: '可自动',
    dailyCap: Number.isFinite(Number(current.routerDailyCap)) ? Number(current.routerDailyCap) : 2,
    cooldownDays: Number.isFinite(Number(current.routerCooldownDays)) ? Number(current.routerCooldownDays) : 3,
  }
}

/**
 * Run one tick, writing the notes it decided on.
 *
 * The only part of this module that touches the store, and it writes **notes only** — never a
 * status, never a dispatch. A tick that changed state would be a decision made without the
 * person who owns the list, which is exactly what `observe` is not.
 *
 * @param {{
 *   service: object,
 *   settings?: { get?: () => object } | object,
 *   sessionAlive?: (id: string) => boolean,
 *   now?: number,
 *   top?: number,
 *   logger?: object,
 * }} options
 * @returns {Promise<object>} the tick's report
 */
export async function runTick(options) {
  const current = typeof options.settings?.get === 'function' ? options.settings.get() : options.settings ?? {}
  const mode = current.routerMode === 'observe' ? 'observe' : 'off'
  if (mode === 'off') {
    return { mode, skipped: true, reason: '分诊未开启（settings.routerMode 是 off）', generatedAt: Date.now(), notes: [] }
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const todos = await options.service.listAll()
  const plan = planTick(todos, {
    now,
    policy: policyFromSettings(current),
    top: options.top,
    sessionAlive: options.sessionAlive,
  })

  const written = []
  let failed = 0
  for (const note of plan.notes) {
    try {
      await options.service.note(note.id, note.text, { by: 'agent' })
      written.push({ id: note.id, kind: note.kind })
    } catch (error) {
      // One unreadable record must not cost the whole tick: the others still deserve their note.
      failed += 1
      options.logger?.warn?.(`dsh-global-todo: 分诊 note 写入失败（${note.id}）：${error?.message ?? error}`)
    }
  }

  return {
    mode,
    skipped: false,
    generatedAt: now,
    counts: plan.snapshot.triage.counts,
    buckets: plan.snapshot.triage.buckets,
    today: plan.snapshot.triage.today,
    notes: written,
    // The caller uses this to decide whether the day is done: a tick that planned notes and
    // wrote none must not be remembered as "today ran".
    failed,
    wouldDispatch: plan.wouldDispatch,
    stalled: plan.snapshot.stalled,
    budget: plan.snapshot.gate.budget,
  }
}
