/**
 * Automatic completion.
 *
 * A hand-off asks a session to do a piece of work. When that session's turn
 * finishes, the record should say so — waiting for the model to remember a tool
 * call is not a mechanism, it is a hope. So the plugin watches the session log
 * itself:
 *
 *   - `assistant/message`   the last thing the agent said (the summary);
 *   - `workspace/changes`   the files that turn touched (the artifacts);
 *   - `turn/end`            why the turn closed — only `completed` counts.
 *
 * Two guards keep this from lying about work nobody did:
 *
 *   1. **Expectation.** Only a session this plugin just dispatched to may be
 *      auto-completed. A conversation that merely happens to be bound is not
 *      finished by the user typing in it.
 *   2. **Reason.** `error`, `aborted` and `interrupted` leave the todo open: a
 *      failed attempt is not a finished job, and saying it is would be the worst
 *      kind of wrong — the work silently disappears.
 *
 * Nothing here throws. An observer that breaks a turn would be far worse than a
 * todo left open.
 */

/** How long an expectation stays valid, so a stale one cannot complete later work. */
const EXPECT_TTL_MS = 6 * 60 * 60 * 1000

/** Sessions tracked at once; a hand-off watcher must not grow without end. */
const MAX_TRACKED = 200

/** Summary kept for one completion. */
const SUMMARY_LIMIT = 2000

/** Artifacts kept for one completion. */
const ARTIFACT_LIMIT = 20

/**
 * How long to wait for the turn's `workspace/changes` event.
 *
 * The change recorder does not append it with `turn/end`: it *enqueues* a
 * turn-end snapshot and diff when the turn closes, and announces the result in a
 * later event. Completing on `turn/end` therefore records an empty artifact list
 * every time — which is exactly what the first version did.
 */
const CHANGES_GRACE_MS = 2500

/**
 * Tools that mean "the agent has decided this todo's fate".
 *
 * A model that writes a blocker note, reopens an item or removes it has spoken
 * for itself; auto-completing on top of that would overrule it. Read-only tools
 * (`list`, `get`) are deliberately not in this set: looking is not deciding.
 */
const VERDICT_TOOLS = Object.freeze(['global_todo_done', 'global_todo_update', 'global_todo_remove'])

/**
 * Plain text of an assistant message.
 *
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** @returns {string} the last path segment, for a readable chip */
function shortName(value) {
  const parts = String(value).split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? String(value) : parts[parts.length - 1]
}

/**
 * Turn a workspace-changes summary into file attachments.
 *
 * @param {unknown} summary
 * @returns {{ kind: 'file', value: string, title: string }[]}
 */
export function artifactsOf(summary) {
  const files = Array.isArray(summary?.files) ? summary.files : []
  const artifacts = []
  for (const file of files) {
    if (typeof file?.path !== 'string' || file.path === '') continue
    const title = typeof file.display === 'string' && file.display !== '' ? file.display : shortName(file.path)
    artifacts.push({ kind: 'file', value: file.path, title })
    if (artifacts.length >= ARTIFACT_LIMIT) break
  }
  return artifacts
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the value looks like a session
 */
function looksLikeSession(value) {
  return value !== null && typeof value === 'object' && typeof value.id === 'string'
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the value looks like a session event
 */
function looksLikeEvent(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string'
}

/**
 * Watch dispatched sessions and close the todo they were handed.
 *
 * @param {{
 *   ctx: object,
 *   service: object,
 *   logger?: { info?: Function, warn?: Function },
 * }} input
 * @returns {{ start: () => () => void, expect: (sessionId: string) => void, expectCount: () => number }}
 */
export function createCompletionWatcher({ ctx, service, logger, schedule, cancel }) {
  const later =
    typeof schedule === 'function'
      ? schedule
      : (milliseconds, callback) => setTimeout(callback, milliseconds)
  const drop = typeof cancel === 'function' ? cancel : (handle) => clearTimeout(handle)
  /** @type {Map<string, object>} */
  const tracked = new Map()
  /** @type {Map<string, number>} */
  const expected = new Map()
  /** In-flight completions, so a slow write is still tracked (and awaitable). */
  let pending = Promise.resolve()
  /** Turns that closed and are waiting for their change summary. */
  const awaitingChanges = new Map()

  const tell = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      /* logging must never be the reason a turn breaks */
    }
  }

  /**
   * @param {string} sessionId
   * @returns {object} the mutable per-session buffer
   */
  function bufferOf(sessionId) {
    let buffer = tracked.get(sessionId)
    if (buffer === undefined) {
      buffer = { summary: '', files: [], changeSeq: 0, reason: '', decided: false }
      tracked.set(sessionId, buffer)
      if (tracked.size > MAX_TRACKED) {
        const oldest = tracked.keys().next()
        if (oldest.done !== true) tracked.delete(oldest.value)
      }
    }
    return buffer
  }

  /**
   * Files for a recorded change event, falling back to the recorder service when
   * the event does not carry the summary inline.
   *
   * @param {string} sessionId
   * @param {number} seq
   * @returns {Promise<object[]>}
   */
  async function filesFor(sessionId, seq) {
    if (seq === 0) return []
    try {
      const recorder = typeof ctx?.get === 'function' ? ctx.get('workspaceChanges') : undefined
      if (recorder === undefined || typeof recorder.summary !== 'function') return []
      return artifactsOf(recorder.summary(sessionId, seq))
    } catch {
      return []
    }
  }

  /**
   * Finish a turn that is waiting for its change summary, once it has one (or the
   * grace period ran out).
   *
   * @param {string} sessionId
   */
  function settleWaiting(sessionId) {
    const waiting = awaitingChanges.get(sessionId)
    if (waiting === undefined) return
    awaitingChanges.delete(sessionId)
    if (waiting.handle !== undefined) drop(waiting.handle)
    // The change event may have landed after the turn closed; prefer its list.
    const buffer = tracked.get(sessionId)
    const files = buffer !== undefined && buffer.files.length > 0 ? buffer.files : waiting.files
    const changeSeq = buffer !== undefined && buffer.changeSeq !== 0 ? buffer.changeSeq : waiting.changeSeq
    const finished = { summary: waiting.summary, files, changeSeq }
    // Serialize: two sessions finishing at once must not interleave writes to
    // the same file, and the caller can await what is still in flight.
    pending = pending.then(() => finalize(sessionId, finished))
  }

  /**
   * Close the todo this session was handed, with what the turn produced.
   *
   * @param {string} sessionId
   * @param {{ summary: string, files: object[], changeSeq: number }} finished
   * @returns {Promise<void>}
   */
  async function finalize(sessionId, finished) {
    try {
      const todo = await service.findBySession(sessionId)
      if (todo === null) return
      const artifacts = finished.files.length > 0 ? finished.files : await filesFor(sessionId, finished.changeSeq)
      await service.complete(
        todo.id,
        { summary: finished.summary, artifacts, sessionId },
        { by: 'agent' },
      )
      tell('info', `auto-completed ${todo.id} from session ${sessionId} (${artifacts.length} artifacts)`)
    } catch (error) {
      tell('warn', `auto-completion failed: ${error?.message ?? String(error)}`)
    }
  }

  /**
   * The `session/event` listener. Accepts either argument order, because the
   * event system hands the scoped session first and the event second, and a
   * misread order would silently disable the feature.
   *
   * @param {unknown} first
   * @param {unknown} second
   */
  function onSessionEvent(first, second) {
    try {
      const session = looksLikeSession(first) ? first : looksLikeSession(second) ? second : undefined
      const event = looksLikeEvent(first) ? first : looksLikeEvent(second) ? second : undefined
      if (session === undefined || event === undefined) return
      const sessionId = session.id
      const buffer = bufferOf(sessionId)

      if (event.type === 'turn/start') {
        // A new turn supersedes anything the previous one left waiting.
        settleWaiting(sessionId)
        buffer.summary = ''
        buffer.files = []
        buffer.changeSeq = 0
        buffer.reason = ''
        buffer.decided = false
        return
      }
      if (event.type === 'tool/call') {
        const name = event.data?.name
        if (typeof name === 'string' && VERDICT_TOOLS.includes(name)) buffer.decided = true
        return
      }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data?.message)
        // Keep the newest non-empty text: the closing message is the summary.
        if (text !== '') buffer.summary = text.slice(0, SUMMARY_LIMIT)
        return
      }
      if (event.type === 'workspace/changes') {
        const inline = artifactsOf(event.data)
        if (inline.length > 0) buffer.files = inline
        else if (typeof event.seq === 'number') buffer.changeSeq = event.seq
        // The summary for the turn that just closed arrived: finish it now.
        const waiting = awaitingChanges.get(sessionId)
        const turn = event.data?.turn
        if (waiting !== undefined && (turn === undefined || turn === waiting.turn)) settleWaiting(sessionId)
        return
      }
      if (event.type !== 'turn/end') return

      buffer.reason = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : ''
      if (buffer.reason !== 'completed') {
        // A failed or cancelled turn is not a finished job. Drop the expectation
        // so a later turn in the same session cannot claim this completion.
        if (expected.delete(sessionId)) {
          tell('warn', `turn ended as "${buffer.reason}" in ${sessionId}; the todo stays open`)
        }
        return
      }
      const stamp = expected.get(sessionId)
      if (stamp === undefined || Date.now() - stamp > EXPECT_TTL_MS) return
      expected.delete(sessionId)
      if (buffer.decided) {
        // The agent said what happened (wrote a note, reopened it, or finished it
        // itself). Guessing on top of a stated answer is how a blocker ends up
        // wearing a "done" label.
        tell('info', `${sessionId} settled the todo itself; no auto-completion`)
        return
      }
      const finished = { turn: event.data?.turn ?? 0, summary: buffer.summary, files: buffer.files, changeSeq: buffer.changeSeq }
      // Wait for this turn's `workspace/changes` event before writing the record,
      // with a bound so a turn that changed nothing still completes.
      const handle = later(CHANGES_GRACE_MS, () => settleWaiting(sessionId))
      awaitingChanges.set(sessionId, { ...finished, handle })
    } catch (error) {
      tell('warn', `completion watcher failed: ${error?.message ?? String(error)}`)
    }
  }

  return {
    /**
     * Register the listener. Safe to call on a Host without the event: the
     * feature simply stays off.
     *
     * @returns {() => void} disposer
     */
    start() {
      if (typeof ctx?.on !== 'function') return () => {}
      try {
        const dispose = ctx.on('session/event', onSessionEvent)
        return typeof dispose === 'function' ? dispose : () => {}
      } catch (error) {
        tell('warn', `could not watch sessions: ${error?.message ?? String(error)}`)
        return () => {}
      }
    },

    /**
     * Declare that a hand-off just went out, so the next completed turn in that
     * session closes the todo.
     *
     * @param {string} sessionId
     */
    expect(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      expected.set(sessionId, Date.now())
    },

    /** @returns {number} number of outstanding expectations (tests, diagnostics) */
    expectCount() {
      return expected.size
    },

    /** @returns {number} turns waiting for their change summary (tests, diagnostics) */
    waitingCount() {
      return awaitingChanges.size
    },

    /**
     * Resolves once every completion started so far has been written.
     *
     * @returns {Promise<void>}
     */
    settled() {
      return pending
    },
  }
}
