/**
 * The service layer: one place where the list changes.
 *
 * Both writers — the human through the panel's HTTP routes and the agent
 * through its tools — call these functions, so validation, the audit trail and
 * the write lock cannot diverge between them. A rule added here applies to both
 * sides at once; that is the whole point of the file.
 *
 * @module dsh-global-todo/service
 */

import { existsSync } from 'node:fs'

import { findDuplicate } from './capture.js'
import { TodoError } from './errors.js'
import { INBOX_TAG, expiredInbox, normalizeIngestItem } from './ingest.js'
import { formatLink } from './links.js'
import { forgetTombstone, mergeDocuments, normalizeTrash, pushTombstone } from './replica.js'
import {
  CAPTURE_SOURCES,
  LIMITS,
  STATUSES,
  addLink as addLinkTo,
  addNote as addNoteTo,
  applyPatch,
  counts,
  createTodo,
  completeTodo,
  isInbox,
  isOverdue,
  newId,
  normalizeActor,
  normalizeStored,
  normalizeTags,
  priorityForDue,
  parseDueText,
  pushActivity,
  recordDispatch as recordDispatchOn,
  removeLink as removeLinkFrom,
  reviewTodo,
  setStatus as setStatusOn,
} from './model.js'

/** Filters the panel and the tools may ask for. */
export const FILTERS = Object.freeze(['all', 'active', 'open', 'doing', 'done', 'cancelled', 'archived', 'overdue'])

/** Sort keys the panel and the tools may ask for. */
export const SORTS = Object.freeze(['created', 'updated', 'due', 'priority'])

// Every level the record can hold, or the comparator silently produces NaN for
// the missing one and the highest-priority items sort last. `urgent` was added
// to the model without this table, so `sort=priority` put P0 at the bottom.
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }

/**
 * How many agent-written records may enter the list in one day.
 *
 * Measured before 0.22.0: about 16 a day, 99% of them written by an agent, and the list turned
 * into a work log. Eight is roughly "two real conversations' worth"; everything past it waits in
 * the inbox, so the cap never loses a record — it only stops the list from being the write path.
 */
export const DAILY_LIST_LIMIT = 8

/** Two timestamps fall on the same local day (the day the person is living in). */
function sameLocalDay(left, right) {
  const a = new Date(left)
  const b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** @param {object} todo @returns {boolean} already waiting for a person */
function inInbox(todo) {
  return (todo.tags ?? []).some((tag) => tag.toLowerCase() === INBOX_TAG)
}

/**
 * How many agent-written records went straight into the list today.
 *
 * Derived from the records themselves rather than kept in a counter: a counter would be a second
 * source of truth that a restart, a second Host process or a sync would each get wrong.
 *
 * @param {object[]} todos
 * @param {number} at
 * @returns {number}
 */
export function listedToday(todos, at) {
  return todos.filter(
    (todo) =>
      todo.createdBy === 'agent' &&
      // `''` is a record from before 0.22.0, when the door was not recorded: count it.
      (todo.captureSource === '' || todo.captureSource === 'tool' || todo.captureSource === 'capture') &&
      !inInbox(todo) &&
      sameLocalDay(todo.createdAt, at),
  ).length
}

/**
 * @param {{ store: object, config?: object, logger?: object, now?: () => number }} options
 */
export function createService(options) {
  const store = options.store
  const config = options.config ?? {}
  const logger = options.logger
  // Optional runtime counters, reported by /health. Absent in most tests, which
  // is why every recording call below is guarded.
  const metrics = options.metrics
  const now = options.now ?? (() => Date.now())
  const requireExistingFiles = config.requireExistingFiles !== false
  const activityLimit = config.activityLimit ?? LIMITS.activity

  /** Link options for {@link import('./links.js').normalizeLink}. */
  const linkOptions = () => ({
    requireExistingFiles,
    exists: (candidate) => {
      try {
        return existsSync(candidate)
      } catch {
        return false
      }
    },
  })

  const modelOptions = (by) => ({
    now: now(),
    by,
    activityLimit,
    usedIds: [],
    ...linkOptions(),
  })

  /**
   * @param {{ todos: object[] }} doc
   * @param {string} id
   * @returns {object}
   */
  function requireTodo(doc, id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TodoError('not-found', '缺少待办 id')
    }
    const todo = doc.todos.find((candidate) => candidate.id === id.trim())
    if (todo === undefined) throw new TodoError('not-found', `没有这条待办：${id}`)
    return todo
  }

  /**
   * @param {object[]} todos
   * @param {{ status?: string, query?: string, tag?: string, sort?: string, limit?: number }} [query]
   * @returns {{ todos: object[], matched: number }} the page and how many matched before it
   */
  /** Friendly level aliases, so search can be written the way the panel talks. */
  const LEVEL_ALIAS = Object.freeze({ p0: 'urgent', p1: 'high', p2: 'normal', p3: 'low' })

  /**
   * Split a search string into field filters and free text.
   *
   * `tag:发布`, `is:overdue`, `has:link`, `level:p0` — all optional, all combinable,
   * and anything else is matched as text, so a plain search keeps working exactly as
   * it did before.
   *
   * @param {string} raw
   * @returns {{ text: string[], tags: string[], levels: string[], flags: string[] }}
   */
/**
 * A due-date bound from a `before:` / `after:` token.
 *
 * Only the explicit deadline shapes are accepted (date, date+time), because a search bound
 * that silently became New Year's Day would filter the list without saying so.
 *
 * @param {string} text e.g. `2026-11-01` or `2026-11-01T18:00`
 * @returns {number | null} epoch millis, or null when the token is not a date bound
 */
function dueBound(text) {
  const verdict = parseDueText(text)
  return verdict.ok === true ? Date.parse(verdict.iso) : null
}
  function parseQuery(raw) {
    const parsed = { text: [], tags: [], levels: [], flags: [], before: null, after: null }
    for (const token of String(raw).split(/\s+/)) {
      if (token === '') continue
      const lower = token.toLowerCase()
      if (lower.startsWith('tag:') && lower.length > 4) parsed.tags.push(lower.slice(4))
      else if (lower.startsWith('#') && lower.length > 1) parsed.tags.push(lower.slice(1))
      else if (lower.startsWith('level:') && lower.length > 6) {
        const value = lower.slice(6)
        parsed.levels.push(LEVEL_ALIAS[value] ?? value)
      } else if (lower.startsWith('before:') && lower.length > 7) {
        // A partial date is what a search box contains while it is being typed; turning that
        // into an error would make the list flicker red on every keystroke. An unparseable
        // bound is therefore ignored, and the token stays a plain search term.
        const bound = dueBound(lower.slice(7))
        if (bound === null) parsed.text.push(lower)
        else parsed.before = bound
      } else if (lower.startsWith('after:') && lower.length > 6) {
        const bound = dueBound(lower.slice(6))
        if (bound === null) parsed.text.push(lower)
        else parsed.after = bound
      } else if (lower.startsWith('is:') && lower.length > 3) parsed.flags.push(lower)
      else if (lower.startsWith('has:') && lower.length > 4) parsed.flags.push(lower)
      else parsed.text.push(lower)
    }
    return parsed
  }

  /**
   * @param {object} todo
   * @param {{ tags: string[], levels: string[], flags: string[] }} parsed
   * @param {number} at
   * @returns {boolean}
   */
  function matchesSyntax(todo, parsed, at) {
    for (const tag of parsed.tags) {
      if (!todo.tags.some((candidate) => candidate.toLowerCase() === tag)) return false
    }
    for (const level of parsed.levels) {
      if (todo.priority !== level) return false
    }
    // A date bound is about the deadline. A todo without one cannot satisfy either bound:
    // "what is due before Friday" has no meaningful answer for something with no deadline.
    if (parsed.before !== null || parsed.after !== null) {
      const due = typeof todo.dueAt === 'string' ? Date.parse(todo.dueAt) : Number.NaN
      if (!Number.isFinite(due)) return false
      if (parsed.before !== null && due >= parsed.before) return false
      if (parsed.after !== null && due <= parsed.after) return false
    }
    for (const flag of parsed.flags) {
      if (flag === 'is:overdue' && !isOverdue(todo, at)) return false
      if (flag === 'is:due' && (todo.dueAt === null || todo.dueAt === undefined)) return false
      if (flag === 'is:active' && todo.status !== 'open' && todo.status !== 'doing') return false
      if (flag === 'has:link' && todo.links.length === 0) return false
      if (flag === 'has:note' && (todo.notes ?? []).length === 0) return false
      if (flag.startsWith('is:') && ['open', 'doing', 'done', 'cancelled'].includes(flag.slice(3))) {
        if (todo.status !== flag.slice(3)) return false
      }
    }
    return true
  }

  function select(todos, query = {}) {
    const filter = typeof query.status === 'string' && query.status !== '' ? query.status : 'all'
    if (!FILTERS.includes(filter)) {
      throw new TodoError('invalid-status', `筛选条件只能是 ${FILTERS.join(' / ')}，收到 ${filter}`)
    }
    const rawQuery = typeof query.query === 'string' ? query.query.trim() : ''
    const parsed = parseQuery(rawQuery)
    const needle = parsed.text.join(' ')
    const tag = typeof query.tag === 'string' ? query.tag.trim().replace(/^#/, '').toLowerCase() : ''
    // The inbox is a separate place, not another status: a record waiting there must not appear
    // in the list, or the gate that put it there would have changed nothing on screen.
    const wantsInbox = tag === INBOX_TAG

    let out = todos.filter((todo) => {
      if (!wantsInbox && isInbox(todo)) return false
      // The status filter and the text/tag filters are independent conditions:
      // asking for `active` must not silently drop the search term.
      const statusMatches =
        filter === 'all'
          ? true
          : filter === 'active'
            ? todo.status === 'open' || todo.status === 'doing'
            : filter === 'overdue'
              ? isOverdue(todo, now())
              : todo.status === filter
      if (!statusMatches) return false
      if (tag !== '' && !todo.tags.some((candidate) => candidate.toLowerCase() === tag)) return false
      if (!matchesSyntax(todo, parsed, now())) return false
      if (parsed.text.length > 0) {
        const haystack = [
          todo.title,
          todo.description,
          (todo.notes ?? []).map((entry) => entry.text).join(' '),
          todo.tags.join(' '),
          todo.links.map((link) => `${link.title} ${link.value}`).join(' '),
        ]
          .join('\n')
          .toLowerCase()
        // Every free word must appear: "npm 发布" should not match either alone.
        if (!parsed.text.every((word) => haystack.includes(word))) return false
      }
      return true
    })

    const sort = typeof query.sort === 'string' && query.sort !== '' ? query.sort : 'created'
    if (!SORTS.includes(sort)) {
      throw new TodoError('invalid-body', `排序只能是 ${SORTS.join(' / ')}，收到 ${sort}`)
    }
    // Every comparator ends on `seq`, which the service assigns monotonically: two todos
    // created in the same millisecond used to tie, and the order then depended on the sort's
    // stability rather than on anything the list guarantees. A CI run caught that.
    const newestFirst = (a, b) => b.createdAt - a.createdAt || (b.seq ?? 0) - (a.seq ?? 0)
    out = out.slice().sort((a, b) => {
      if (sort === 'updated') return b.updatedAt - a.updatedAt || (b.seq ?? 0) - (a.seq ?? 0)
      if (sort === 'due') {
        const left = a.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.dueAt)
        const right = b.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.dueAt)
        if (left !== right) return left - right
        return newestFirst(a, b)
      }
      if (sort === 'priority') {
        const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        if (rank !== 0) return rank
        return newestFirst(a, b)
      }
      return newestFirst(a, b)
    })

    const limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 1000) : 200
    // matched is the count before the page is cut. Returning only the page made the
    // panel show 200 for a list of 350 with no way to tell -- the caller now has
    // enough to say 'showing 200 of 350' instead of quietly lying.
    return { todos: out.slice(0, limit), matched: out.length }
  }

  /**
   * @param {{ status?: string, query?: string, tag?: string, sort?: string, limit?: number }} [query]
   * @returns {Promise<{ todos: object[], counts: object, matched: number, truncated: boolean }>}
   */
  /**
   * Every stored todo, unfiltered and unpaged.
   *
   * For aggregates that must not be narrowed by whatever the panel is currently
   * showing — a weekly report over the visible page would be a lie of omission.
   *
   * @returns {Promise<object[]>}
   */
  async function listAll() {
    return store.all()
  }

  async function list(query = {}) {
    const todos = await store.all()
    const selected = select(todos, query)
    return {
      todos: selected.todos,
      counts: counts(todos, now()),
      matched: selected.matched,
      truncated: selected.matched > selected.todos.length,
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<object>}
   */
  async function get(id) {
    const todos = await store.all()
    return requireTodo({ todos }, id)
  }

  /**
   * @param {object} input
   * @param {{ by?: 'human' | 'agent', origin?: { dir?: string, sessionId?: string } }} [context]
   * @returns {Promise<object>} the created todo
   */
  async function create(input, context = {}) {
    return store.update((doc) => {
      const by = normalizeActor(context.by)
      // The door that wrote this record. The panel's own form is a person; everything else is
      // an agent, and the two agent doors are the ones that need a gate.
      const source = CAPTURE_SOURCES.includes(context.source) ? context.source : by === 'human' ? 'human' : 'tool'
      const todo = createTodo(input, {
        ...modelOptions(by),
        // A person's entry keeps the level they typed; an agent's is derived from the deadline
        // (`priorityForDue`) and its own choice is kept as `suggestedPriority`.
        prioritySource: by === 'human' ? 'human' : 'rule',
        captureSource: source,
        usedIds: doc.todos.map((candidate) => candidate.id),
        ...(context.origin === undefined ? {} : { origin: context.origin }),
      })
      // The gate: an agent-written record with no deadline — or one that arrives after the day's
      // allowance — waits in the inbox instead of becoming the list. It is not dropped, and the
      // reason is on the record, because "why is this here" is the question the inbox must answer.
      if ((source === 'tool' || source === 'capture') && todo.status === 'open') {
        const at = now()
        const reason =
          todo.dueAt === null ? 'no-due' : listedToday(doc.todos, at) >= DAILY_LIST_LIMIT ? 'quota' : ''
        if (reason !== '') {
          todo.tags = normalizeTags([...todo.tags, INBOX_TAG])
          todo.inboxReason = reason
          pushActivity(
            todo,
            {
              kind: 'inboxed',
              by,
              at,
              summary:
                reason === 'no-due'
                  ? '没有截止时间：先进收件箱，等你确认'
                  : `今天已有 ${DAILY_LIST_LIMIT} 条进了清单：先进收件箱`,
            },
            activityLimit,
          )
        }
      }
      // Stable, human-facing number: the store fills gaps on read, the service assigns the
      // next one on create so "#42" keeps meaning #42.
      todo.seq = doc.todos.reduce((max, candidate) => Math.max(max, candidate.seq ?? 0), 0) + 1
      doc.todos.push(todo)
      metrics?.recordList?.('created', doc.todos.length)
      logger?.debug?.(`dsh-global-todo: created ${todo.id}${todo.inboxReason === '' ? '' : ` (inbox: ${todo.inboxReason})`}`)
      return { next: doc.todos, result: todo }
    })
  }

  /**
   * Did this conversation record anything itself since `since`?
   *
   * The auto-collect question exists so a quiet conversation can offer what it has not recorded.
   * A conversation whose agent already wrote a todo in the same turn has just done that, so
   * asking again is the mechanism that made the list noisy (reported 2026-10-30).
   *
   * @param {string} sessionId
   * @param {number} since - epoch ms
   * @returns {Promise<object | null>} the newest such record, or null
   */
  async function capturedSince(sessionId, since) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const todos = await store.all()
    const hits = todos
      .filter((todo) => todo.originSessionId === sessionId && todo.createdBy === 'agent' && todo.createdAt >= since)
      .sort((left, right) => right.createdAt - left.createdAt)
    return hits[0] ?? null
  }

  /**
   * The one-time upgrade pass: apply the gate and the level rule to what is already on the list.
   *
   * Run once, at first start under 0.22.0. Two things happen to **active** records only:
   *
   *  1. an agent-written record with no deadline that is not already waiting moves to the inbox
   *     (`inboxReason: 'no-due'`) — otherwise the gate would only govern tomorrow's records while
   *     the 74 unscheduled ones written yesterday kept the list unusable;
   *  2. a rule-governed record's level is recomputed from its deadline.
   *
   * Records a person created or edited are never touched by either step. Both steps bump
   * `updatedAt` and leave an activity entry, so the change converges across machines instead of
   * being an edit that only this copy knows about.
   *
   * @param {{ now?: number }} [options]
   * @returns {Promise<{ inboxed: number, releveled: number }>}
   */
  async function migrate(options = {}) {
    const at = options.now ?? now()
    return store.update((doc) => {
      let inboxed = 0
      let releveled = 0
      for (const todo of doc.todos) {
        if (todo.status !== 'open' && todo.status !== 'doing') continue
        // A record a person has touched is theirs: the sweep is for the agent's own pile, and
        // "you edited it" is the only signal that it was deliberately kept.
        if (todo.createdBy === 'agent' && todo.updatedBy !== 'human' && todo.dueAt === null && !inInbox(todo)) {
          const source = todo.captureSource ?? ''
          if (source === '' || source === 'tool' || source === 'capture') {
            todo.tags = normalizeTags([...todo.tags, INBOX_TAG])
            todo.inboxReason = 'no-due'
            todo.updatedAt = at
            pushActivity(
              todo,
              { kind: 'inboxed', by: 'agent', at, summary: '升级到 0.22：没有截止时间，移进收件箱' },
              activityLimit,
            )
            inboxed += 1
            // A record that just moved is not also re-levelled in the same pass: it is not on the
            // list, and its level will be derived when (if) it is confirmed.
            continue
          }
        }
        // Not while it is waiting: a record in the inbox is not on the list, and its level is
        // derived when it is confirmed (see applyPatch).
        if (todo.prioritySource !== 'rule' || inInbox(todo)) continue
        const ruled = priorityForDue(todo.dueAt, { now: at })
        if (ruled === todo.priority) continue
        todo.priority = ruled
        todo.updatedAt = at
        releveled += 1
      }
      return inboxed === 0 && releveled === 0 ? { result: { inboxed: 0, releveled: 0 } } : { next: doc.todos, result: { inboxed, releveled } }
    })
  }

  /**
   * @param {string} id
   * @param {object} patch
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, changed: string[] }>}
   */
  async function update(id, patch, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const changed = applyPatch(todo, patch, {
        ...modelOptions(context.by),
        ...linkOptions(),
      })
      return changed.length === 0 ? { result: { todo, changed } } : { next: doc.todos, result: { todo, changed } }
    })
  }

  /**
   * @param {string} id
   * @param {string} status
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<object>}
   */
  async function setStatus(id, status, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const changed = setStatusOn(todo, status, modelOptions(context.by))
      return changed ? { next: doc.todos, result: todo } : { result: todo }
    })
  }

  /**
   * Answer the review mark an agent's completion left behind.
   *
   * Kept separate from {@link setStatus} because it is a different decision: the record is
   * already done, and the owner is either agreeing or sending it back — not changing a
   * status that nobody asked about. A record without a pending mark is refused, so the
   * panel cannot confirm something twice.
   *
   * @param {string} id
   * @param {'confirm' | 'reject'} decision
   * @param {{ by?: 'human' | 'agent', reason?: string }} [context]
   * @returns {Promise<object>} the todo after the decision
   */
  async function review(id, decision, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      if (todo.review?.pending !== true) {
        throw new TodoError('invalid-status', '这条待办没有等你确认的完成标记')
      }
      const changed = reviewTodo(todo, decision, {
        ...modelOptions(context.by ?? 'human'),
        reason: context.reason,
      })
      return changed ? { next: doc.todos, result: todo } : { result: todo }
    })
  }

  /**
   * Put a wrongly-finished todo back on the list.
   *
   * Deliberately narrower than {@link setStatus}: only a `done` or `cancelled` record
   * can be reopened, so this can never grow into a second way to *finish* something.
   * A record that is already open (or in progress) is refused rather than reported as
   * a success — in that case the caller's premise is what is wrong, and saying so is
   * the honest answer.
   *
   * @param {string} id
   * @param {{ by?: 'human' | 'agent', reason?: string }} [context]
   * @returns {Promise<object>} the reopened todo
   */
  async function reopen(id, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      if (todo.status !== 'done' && todo.status !== 'cancelled') {
        throw new TodoError(
          'invalid-status',
          `这条待办的状态是 ${todo.status}，不是 done / cancelled，没有需要复open的完成标记`,
        )
      }
      const changed = setStatusOn(todo, 'open', { ...modelOptions(context.by), reason: context.reason })
      return changed ? { next: doc.todos, result: todo } : { result: todo }
    })
  }

  /**
   * Mark a todo finished, with the evidence the work produced.
   *
   * @param {string} id
   * @param {{ summary?: string, artifacts?: unknown[], sessionId?: string }} evidence
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, changed: boolean }>}
   */
  async function complete(id, evidence = {}, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const changed = completeTodo(todo, evidence, { ...modelOptions(context.by ?? 'agent'), ...linkOptions() })
      return { next: doc.todos, result: { todo, changed } }
    })
  }

  /**
   * Append a progress note.
   *
   * @param {string} id
   * @param {string} text
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, note: object }>}
   */
  async function note(id, text, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const created = addNoteTo(todo, text, modelOptions(context.by ?? 'agent'))
      metrics?.recordList?.('noted')
      return { next: doc.todos, result: { todo, note: created } }
    })
  }

  /**
   * A copy of the todo whose file attachments carry `missing` when the file is gone.
   *
   * Computed on read, never stored: a file that moves back must stop being flagged,
   * and a stale flag in the record would outlive the problem.
   *
   * @param {object} todo
   * @returns {object}
   */
  function annotateLinks(todo) {
    const checker = linkOptions().exists
    const check = checker ?? (() => true)
    return {
      ...todo,
      links: todo.links.map((link) => {
        // A dead image must be flagged exactly like a dead document: the panel would
        // otherwise render a broken frame instead of the existing missing-file chip.
        if (link.kind !== 'file' && link.kind !== 'image') return { ...link }
        let present = true
        try {
          present = check(link.value) !== false
        } catch {
          present = true
        }
        return present ? { ...link } : { ...link, missing: true }
      }),
    }
  }

  /**
   * The open todo a session is responsible for, if any.
   *
   * Used by the completion watcher: a session's turn ending must find exactly
   * the record it was handed.
   *
   * @param {string} sessionId
   * @returns {Promise<object | null>}
   */
  async function findBySession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const todos = await store.all()
    return (
      todos.find((todo) => todo.sessionId === sessionId && (todo.status === 'open' || todo.status === 'doing')) ?? null
    )
  }

  /**
   * Put a removed record back exactly as it was.
   *
   * This is what the panel's undo button calls: the id, the creation time, the
   * attachments and the activity trail all come back, so an accidental delete
   * costs nothing. A record whose id is taken is refused rather than merged.
   *
   * @param {unknown} record - a full todo record
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<object>}
   */
  async function restore(record, context = {}) {
    return store.update((doc) => {
      const todo = normalizeStored(record, { activityLimit })
      if (todo === null) throw new TodoError('invalid-body', '这条记录无法还原：缺少 id 或标题')
      if (doc.todos.some((candidate) => candidate.id === todo.id)) {
        throw new TodoError('invalid-body', `id 已存在，不能还原：${todo.id}`)
      }
      todo.updatedAt = now()
      todo.updatedBy = normalizeActor(context.by)
      pushActivity(todo, { kind: 'restored', by: context.by, at: now(), summary: todo.title }, activityLimit)
      doc.todos.push(todo)
      // Undo has to revoke the deletion, not only re-add the record: a tombstone left behind
      // would delete the restored copy again at the next fold.
      doc.trash = forgetTombstone(doc.trash, todo.id)
      metrics?.recordList?.('restored', doc.todos.length)
      return { next: doc.todos, result: todo }
    })
  }

  /**
   * @param {string} id
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<object>} the removed todo
   */
  async function remove(id, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      doc.todos = doc.todos.filter((candidate) => candidate.id !== todo.id)
      // The mark is what stops the next copy from another machine putting the record back;
      // a deletion that leaves no trace is a deletion the other side never learns about.
      doc.trash = pushTombstone(doc.trash, { id: todo.id, at: now(), by: normalizeActor(context.by) })
      metrics?.recordList?.('removed', doc.todos.length)
      logger?.debug?.(`dsh-global-todo: removed ${todo.id} by ${context.by ?? 'human'}`)
      return { next: doc.todos, result: todo }
    })
  }

  /**
   * @param {string} id
   * @param {unknown} link
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, added: boolean, link: object }>}
   */
  async function addLink(id, link, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const outcome = addLinkTo(todo, link, {
        ...modelOptions(context.by),
        ...linkOptions(),
      })
      return outcome.added
        ? { next: doc.todos, result: { todo, added: true, link: outcome.link } }
        : { result: { todo, added: false, link: outcome.link } }
    })
  }

  /**
   * @param {string} id
   * @param {{ index?: number, key?: string }} ref
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, removed: object | null }>}
   */
  async function removeLink(id, ref, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const removed = removeLinkFrom(todo, ref ?? {}, modelOptions(context.by))
      return removed === null ? { result: { todo, removed: null } } : { next: doc.todos, result: { todo, removed } }
    })
  }

  /**
   * Record the outcome of a hand-off. Never throws for a missing todo: the
   * caller is already on an error path and must not lose the original reason.
   *
   * @param {string} id
   * @param {{ mode: string, sessionId?: string, ok: boolean, error?: string }} info
   * @returns {Promise<object | null>}
   */
  async function recordDispatch(id, info) {
    try {
      return await store.update((doc) => {
        const todo = requireTodo(doc, id)
        recordDispatchOn(todo, info, { now: now(), activityLimit })
        return { next: doc.todos, result: todo }
      })
    } catch (error) {
      logger?.warn?.(`dsh-global-todo: 记录派发结果失败（${id}）：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * @param {object} todo
   * @returns {string} the prompt a dispatched session receives
   */
  function dispatchPrompt(todo) {
    const lines = ['【全局待办 · 交给 Agent】', `待办：${todo.title}`]
    if (todo.description !== '') {
      lines.push('', '描述：', todo.description)
    }
    // The plan, if there is one: a numbered list is what makes a hand-off concrete, and
    // the ticks say which parts are already behind us.
    const steps = Array.isArray(todo.steps) ? todo.steps : []
    if (steps.length > 0) {
      lines.push('', `步骤（共 ${steps.length} 步）：`)
      steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.done === true ? '[已完成] ' : ''}${step.text}`)
      })
    }
    if (todo.links.length > 0) {
      lines.push('', '相关文档与地址：')
      for (const link of todo.links) {
        lines.push(`- ${link.kind === 'url' ? '地址' : '文档'}：${formatLink(link)}`)
      }
    }
    if (todo.dueAt !== null) lines.push('', `截止：${todo.dueAt}`)
    if (todo.tags.length > 0) lines.push(`标签：${todo.tags.join(', ')}`)
    lines.push('', `这条待办加入于 ${new Date(todo.createdAt).toISOString()}，id 是 ${todo.id}。`)
    lines.push('请现在开始处理它。')
    lines.push(
      `做完后调用 global_todo_done 工具，带上 id=${todo.id}、`
        + '`summary`（一句话：做了什么、结论是什么）和 `artifacts`（这次产出的文件绝对路径或相关网址）——'
        + '清单上留下的完成记录就是这些，缺了它「已完成」等于什么都没说。',
    )
    lines.push('做不完或做不了，就说明卡在哪里，**不要**把它标为完成。')
    return lines.join('\n')
  }

  /**
   * The message the panel injects when it asks a conversation to collect todos.
   *
   * It states both sides, like the system-prompt guidance: a conversation asked to
   * "capture things" will otherwise record its own plan and small talk.
   *
   * @returns {string}
   */
  function capturePrompt() {
    return [
      '【全局待办 · 抓取】',
      '扫一下我们这个对话里需要**跨会话跟进**的事，用 global_todo_capture 一次登记。',
      '',
      '**精炼、合并**（重要）：',
      '- 一件事只记**一条**；同一主题的零散小点**合并成一条**，写进那一条的描述里，不要拆成多条；',
      '- 标题一句话说清「要做什么」（别写成段落，也别抄原文）；',
      '- **宁可 1–3 条也不要 8 条**：只留真正需要跨会话/跨设备/等别人才能推进的事；',
      '- 已经讨论完、你能立刻做完、或者清单里**已经有**的，不要记。',
      '',
      '该记的：等对方回复、待确认的决定、答应别人的事、还没收尾且需要另开一个会话继续的一步。',
      '每条必要时补描述、挂上相关文档**绝对路径**或网址，并标级别（P0 紧急 / P1 高 / P2 常规 / P3 低）。',
      '工具会给每条算一个 0–1 的权重，低于设置的 captureMinWeight 会被跳过（犹豫措辞、纯疑问句、只有一句话没有细节的条目权重低）——'
        + '所以标题写具体、带上原话和截止时间，比多写几条更有用。',
      '',
      '**写截止时间**：用户提到「明天 / 周五 / 月底」就换算成 `dueAt`——没有截止时间的条目会先进「收件箱」等用户确认，'
        + '有截止时间的才直接进清单。级别不用你猜：清单会按截止时间自动给（48 小时内 = P1，已逾期 = P0，没有日期 = P3）。',
      '',
      '**带上原话**（重要）：每条用 `evidence` 逐字引用用户说的那一句（最多 ' + LIMITS.evidence + ' 字，不要改写、不要总结）。',
      '以后看到这条待办的人，要能一眼核对「有没有听错」；没有原话的抓取，只是一条无从核对的转述。',
      '',
      '记完用**一句话**汇总（例如「记了 2 条：X 与 Y」），不要逐条复述。',
    ].join('\n')
  }

  /**
   * The question the Host asks on its own, which is not the same question a person asks.
   *
   * `capturePrompt` is "I asked you to collect", so it errs towards completeness. This one runs
   * unattended every time a conversation goes quiet, and every extra record it produces is a
   * record nobody asked for. So it is allowed to come back with nothing, it names the three cases
   * that qualify, and it caps itself at two records.
   */
  function autoCapturePrompt() {
    return [
      '【全局待办 · 自动检查】',
      '这个对话安静下来了，宿主让我问你一次：有没有**必须跨会话跟进**的事？',
      '',
      '**没有就直说「没有要记的」**——不要为了交差硬凑，这一条比下面所有规则都重要。',
      '',
      '只记这三类：① 在等别人（回复、审核、到货、凭证）；② 有明确截止日期或时间点；③ 你答应过用户、但这轮做不完、要另开会话继续。',
      '不要记：这轮已经做完的、用户没同意的打算、纯讨论、想法、清单里已经有的。',
      '',
      '**一次最多 2 条。**每条**能写截止时间就必须写 `dueAt`**（用户说「明天 / 周五 / 月底」就换算成日期）——'
        + '没有截止时间的条目会先进「收件箱」等用户确认，不会直接进清单；级别由截止时间自动定，不用你猜。',
      '标题一句话说清「要做什么」；必要时补描述、挂文档绝对路径或网址，并用 `evidence` 逐字引用用户那句原话。',
      '记完一句话汇总：记了哪几条（没有就说没有）。',
    ].join('\n')
  }

  /**
   * The list exactly as it is stored.
   *
   * Deliberately the raw document, not the annotated shape `/list` returns: an
   * export is what a round trip has to hand back, and a `missing` flag or a live
   * session's directory are runtime facts that do not belong in it.
   *
   * @returns {Promise<{ version: number, todos: object[] }>}
   */
  async function exportDocument() {
    const doc = await store.read()
    // Deletions are part of the document: an export that dropped them would bring back
    // every record removed since the copy was made.
    return { version: doc.version, todos: doc.todos, trash: doc.trash }
  }

  /**
   * Load a previously exported document back into the list.
   *
   * `replace` makes the list exactly the document, which is what a round trip
   * needs; `merge` updates by id and appends what is new, which is what restoring
   * a backup into a list that has since moved on needs. A record that cannot be
   * read fails the whole import: a partial write would be a silent loss, and that
   * is the one outcome this must never have.
   *
   * @param {unknown} input - the exported document, or a bare `{ todos }`
   * @param {{ mode?: string }} [context]
   * @returns {Promise<{ mode: string, imported: number, total: number, todos: object[] }>}
   */
  async function importDocument(input, context = {}) {
    const doc = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const raw = Array.isArray(doc.todos) ? doc.todos : []
    if (raw.length === 0) throw new TodoError('invalid-body', '这份 JSON 里没有待办：需要一个非空的 todos 数组')
    const mode = context.mode === 'merge' ? 'merge' : 'replace'
    // A document written by an older version has no tombstones; that only means it cannot
    // tell us about deletions, never that it saw none.
    const trash = normalizeTrash(doc.trash)
    const records = []
    const seen = new Set()
    for (const [index, item] of raw.entries()) {
      const todo = normalizeStored(item, { activityLimit })
      if (todo === null) throw new TodoError('invalid-body', `第 ${index + 1} 条无法读取：缺少 id 或标题`)
      if (seen.has(todo.id)) throw new TodoError('invalid-body', `第 ${index + 1} 条与前面的记录 id 重复：${todo.id}`)
      seen.add(todo.id)
      records.push(todo)
    }
    if (context.dryRun === true) {
      const existing = await store.all()
      const known = new Set(existing.map((todo) => todo.id))
      const wouldCreate = records.filter((record) => !known.has(record.id)).length
      return {
        mode,
        dryRun: true,
        wouldImport: records.length,
        wouldCreate,
        wouldUpdate: records.length - wouldCreate,
        total: mode === 'merge' ? existing.length + wouldCreate : records.length,
      }
    }
    return store.update((existing) => {
      // Both directions go through the same fold the multi-machine sync uses: a imported
      // backup is just another replica, and a deletion in it has to win over a copy that
      // still has the record.
      const folded =
        mode === 'merge'
          ? mergeDocuments(existing, { todos: records, trash }, { now: now() })
          : { todos: records, trash }
      existing.trash = folded.trash
      metrics?.recordList?.('imports', folded.todos.length)
      return {
        next: folded.todos,
        result: {
          mode,
          imported: records.length,
          total: folded.todos.length,
          todos: folded.todos,
          removed: folded.stats?.removed ?? 0,
        },
      }
    })
  }

  /**
   * Apply one change to several todos.
   *
   * Each record goes through the same validation and trail as a single edit. A stale id is
   * reported in `unmatched` instead of failing the batch: a selection is a human gesture, and
   * one row that moved must not discard the other nine.
   *
   * @param {string[]} ids
   * @param {{ status?: string, addTags?: string[], removeTags?: string[] }} change
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ updated: number, ids: string[], unmatched: string[], errors: { id: string, error: string }[] }>}
   */
  async function bulk(ids, change = {}, context = {}) {
    const wanted = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.trim() !== '') : []
    if (wanted.length === 0) throw new TodoError('invalid-body', '要改哪些待办？给一个非空的 ids')
    const hasStatus = typeof change.status === 'string' && change.status !== ''
    const addTags = Array.isArray(change.addTags) ? change.addTags : []
    const removeTags = Array.isArray(change.removeTags) ? change.removeTags : []
    if (!hasStatus && addTags.length === 0 && removeTags.length === 0) {
      throw new TodoError('invalid-body', '批量修改需要 status / addTags / removeTags 之一')
    }
    const updated = []
    const unmatched = []
    const errors = []
    for (const id of wanted) {
      try {
        const todo = await store.update((doc) => {
          const target = doc.todos.find((candidate) => candidate.id === id)
          if (target === undefined) return { result: null }
          const patch = {}
          if (hasStatus) patch.status = change.status
          if (addTags.length > 0 || removeTags.length > 0) {
            const merged = new Map(target.tags.map((tag) => [tag.toLowerCase(), tag]))
            for (const tag of addTags) merged.set(String(tag).toLowerCase(), String(tag))
            for (const tag of removeTags) merged.delete(String(tag).toLowerCase())
            patch.tags = [...merged.values()]
          }
          const changed = applyPatch(target, patch, { ...modelOptions(context.by), ...linkOptions() })
          return changed.length === 0 ? { result: target } : { next: doc.todos, result: target }
        })
        if (todo === null) unmatched.push(id)
        else updated.push(id)
      } catch (error) {
        errors.push({ id, error: error instanceof TodoError ? error.message : String(error?.message ?? error) })
      }
    }
    return { updated: updated.length, ids: updated, unmatched, errors }
  }

  /**
   * Write external items through the same path as everything else.
   *
   * The gate decides per item; a rejected item is reported, never silently dropped, and a
   * partial batch is normal — one bad mail must not discard the other nine.
   *
   * @param {object[]} items
   * @param {{ confirmBelow?: number, dryRun?: boolean }} [options]
   * @returns {Promise<{ created: object[], skipped: object[], preview: object[] }>}
   */
  async function ingest(items, options = {}) {
    const existing = (await store.all()).slice()
    const created = []
    const skipped = []
    const preview = []
    for (const raw of Array.isArray(items) ? items : []) {
      const verdict = normalizeIngestItem(raw, { confirmBelow: options.confirmBelow })
      if (verdict.error !== undefined) {
        skipped.push({
          title: typeof raw?.title === 'string' ? raw.title.slice(0, 80) : '',
          reason: 'invalid',
          error: verdict.error,
        })
        continue
      }
      const duplicate = findDuplicate({ title: verdict.item.title, existing, now: now() })
      if (duplicate.duplicate === true) {
        skipped.push({
          title: verdict.item.title.slice(0, 80),
          reason: duplicate.reason,
          error: '清单里已有重复条目，未重复登记',
        })
        continue
      }
      if (options.dryRun === true) {
        preview.push({ title: verdict.item.title, tags: verdict.item.tags, inbox: verdict.inbox })
        continue
      }
      // One bad row must not take the batch down with it: `global_todo_capture` already
      // isolates each create, and the HTTP door should behave the same way.
      let todo
      try {
        todo = await create(verdict.item, { by: 'agent', source: 'ingest' })
      } catch (error) {
        skipped.push({
          title: verdict.item.title.slice(0, 80),
          reason: 'invalid',
          error: error?.message ?? String(error),
        })
        continue
      }
      created.push(todo)
      existing.push(todo)
    }
    return { created, skipped, preview }
  }

  /**
   * Archive inbox records nobody confirmed in time.
   *
   * @param {{ days?: number }} [options]
   * @returns {Promise<{ expired: number }>}
   */
  async function expireInbox(options = {}) {
    const days = Number.isFinite(options.days) && options.days > 0 ? options.days : 7
    const at = now()
    // No stale records, no write: the mount-time sweep must not touch the file just to
    // report that it had nothing to do.
    if (expiredInbox(await store.all(), { now: at, days }).length === 0) return { expired: 0 }
    return store.update((doc) => {
      const stale = expiredInbox(doc.todos, { now: at, days })
      for (const todo of stale) {
        setStatusOn(todo, 'archived', { now: at, by: 'agent', reason: `收件箱超过 ${days} 天未确认` })
      }
      return { next: doc.todos, result: { expired: stale.length } }
    })
  }

  /** @returns {Promise<object>} counts for the panel header and tool summaries */
  async function stats() {
    const todos = await store.all()
    return counts(todos, now())
  }

  /**
   * Which finished todos an agent marked done that a person has not confirmed.
   *
   * The count in `/health` says something is waiting; this says what, so a check does not
   * have to open the panel and click through the list to find out.
   *
   * @param {number} [limit] newest first, capped
   * @returns {Promise<{ id: string, seq: number, title: string, doneAt: number }[]>}
   */
  async function awaitingReview(limit = 20) {
    const todos = await store.all()
    return todos
      .filter((todo) => todo.status === 'done' && todo.review?.pending === true)
      .sort((left, right) => (right.doneAt ?? right.updatedAt ?? 0) - (left.doneAt ?? left.updatedAt ?? 0))
      .slice(0, limit)
      .map((todo) => ({ id: todo.id, seq: todo.seq, title: todo.title, doneAt: todo.doneAt ?? todo.updatedAt ?? 0 }))
  }

  return {
    list,
    listAll,
    get,
    awaitingReview,
    create,
    update,
    setStatus,
    review,
    reopen,
    complete,
    note,
    annotateLinks,
    findBySession,
    remove,
    restore,
    bulk,
    ingest,
    expireInbox,
    addLink,
    removeLink,
    recordDispatch,
    exportDocument,
    importDocument,
    select,
    dispatchPrompt,
    capturePrompt,
    autoCapturePrompt,
    capturedSince,
    migrate,
    stats,
    describe: () => store.describe(),
    statuses: STATUSES,
  }
}
