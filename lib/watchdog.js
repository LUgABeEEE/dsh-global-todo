/**
 * The progress watchdog: a hand-off that went quiet without saying anything.
 *
 * `lastDispatch` records whether a hand-off *started*; nothing recorded whether it got
 * anywhere. A worker that silently stalls is the worst outcome this list can produce — the
 * person sees 「已派发」, believes it is moving, and the record rots under a green label.
 *
 * The honest signal available without reading another process's session log is the one the
 * contract already asks for: a worker that makes progress **writes it back** (`/note`,
 * `/status`, `global_todo_done`). Everything here is derived from the record itself, so the
 * verdict survives a restart, syncs to the other machine, and can be argued with — no
 * heuristics about "looked busy".
 *
 * Pure: no clock (the caller passes `now`), no I/O.
 *
 * @module dsh-global-todo/watchdog
 */

/** How long a dispatched record may stay silent before it counts as stalled. */
export const STALL_HOURS = 24

import { isBookkeepingNote } from './marks.js'

/**
 * Activity kinds that are *the hand-off itself*, not progress on it.
 *
 * Counting these as progress would make every dispatch look alive for exactly one event and
 * then fall silent — which is the failure this module exists to name.
 */
const DISPATCH_KINDS = ['dispatched', 'dispatch-failed']

/**
 * Records that were handed over and have said nothing since.
 *
 * @param {object[]} todos
 * @param {{ now?: number, hours?: number, sessionAlive?: (sessionId: string) => boolean }} [options]
 * @returns {{ id: string, seq: number, title: string, sinceAt: number, hours: number, sessionId: string, live: boolean }[]}
 */
export function findStalled(todos, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const hours = Number.isFinite(options.hours) && options.hours > 0 ? options.hours : STALL_HOURS
  const threshold = hours * 3_600_000
  const out = []

  for (const todo of Array.isArray(todos) ? todos : []) {
    if (todo === null || typeof todo !== 'object') continue
    if (todo.status !== 'open' && todo.status !== 'doing') continue
    const last = todo.lastDispatch
    if (last === null || typeof last !== 'object' || last.ok !== true) continue
    const sinceAt = Number(last.at)
    if (!Number.isFinite(sinceAt) || sinceAt <= 0) continue

    const silent = now - sinceAt
    if (silent < threshold) continue

    // Anything the record itself gained after the hand-off counts as progress, including a
    // person's note and an agent's completion. The dispatch's own trail does not.
    // A note the plugin wrote about the record — the daily triage line, a snooze, a chase —
    // is not work on it. Counting those would make every record the triage once mentioned look
    // alive forever, which is the silent green label this module exists to remove.
    const activity = Array.isArray(todo.activity) ? todo.activity : []
    const progressed = activity.some(
      (entry) => entry !== null && typeof entry === 'object'
        && Number(entry.at) > sinceAt
        && DISPATCH_KINDS.includes(entry.kind) !== true
        && isBookkeepingNote(entry.summary) !== true,
    )
    if (progressed) continue

    const notes = Array.isArray(todo.notes) ? todo.notes : []
    if (notes.some((note) => Number(note?.at) > sinceAt && isBookkeepingNote(note?.text) !== true)) continue

    const sessionId = typeof todo.sessionId === 'string' ? todo.sessionId : ''
    out.push({
      id: todo.id,
      seq: todo.seq,
      title: todo.title,
      sinceAt,
      hours: Math.floor(silent / 3_600_000),
      sessionId,
      live: typeof options.sessionAlive === 'function' ? options.sessionAlive(sessionId) === true : false,
    })
  }

  return out
}
