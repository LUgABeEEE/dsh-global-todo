/**
 * The todo entity: one plain, serializable record.
 *
 * Records are intentionally boring JSON — no class instances, no Dates — so the
 * list file stays readable, hand-editable and diffable, and so a corrupt or
 * hand-mangled entry can be tolerated on load instead of taking the list down.
 *
 * Everything here mutates a record in place and is driven by the service layer,
 * which owns persistence and the write lock.
 *
 * @module dsh-global-todo/model
 */

import { randomUUID } from 'node:crypto'

import { TodoError } from './errors.js'
import { LINK_KINDS, linkKey, normalizeLink } from './links.js'

/** Bumped whenever the stored shape changes in a way that needs migration. */
export const SCHEMA_VERSION = 1

/** Lifecycle states. `doing` is the explicit "an agent (or I) am on it" state. */
export const STATUSES = Object.freeze(['open', 'doing', 'done', 'cancelled', 'archived'])

/** Priorities are deliberately coarse: three levels people actually use. */
/**
 * Levels, most urgent first: P0 紧急 / P1 高 / P2 常规 / P3 低.
 *
 * `urgent` was added in front of the original three, which is why the older
 * names stay valid: a record written before levels existed still loads without a
 * migration, and `normal` remains the default.
 */
export const PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low'])

/** Human labels for the levels, in the same order. */
export const PRIORITY_LABELS = Object.freeze({
  urgent: 'P0 紧急',
  high: 'P1 高',
  normal: 'P2 常规',
  low: 'P3 低',
})

/** Who performed a write. Recorded on every entry of the activity trail. */
export const ACTORS = Object.freeze(['human', 'agent'])

/** Field limits. Exported so the tools' JSON Schemas and the tests agree. */
export const LIMITS = Object.freeze({
  title: 200,
  description: 10000,
  tags: 20,
  tag: 32,
  activity: 50,
  note: 2000,
  notes: 50,
  // A todo is a unit of work, not a project plan: a list longer than this is a sign the
  // item should be split, and a cap keeps the dispatch prompt from becoming a document.
  steps: 20,
  step: 200,
  // The sentence the item came from. A captured todo without its source reads as an
  // opinion later; with it, the person can check whether it was heard correctly.
  evidence: 300,
})

/**
 * Short, human-quotable id. `t-` + 8 hex characters; collision-checked against
 * the ids already in the list.
 *
 * @param {Iterable<string>} [used]
 * @returns {string}
 */
export function newId(used = []) {
  const taken = new Set(used)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `t-${randomUUID().replace(/-/g, '').slice(0, 8)}`
    if (!taken.has(candidate)) return candidate
  }
  throw new TodoError('internal', '无法生成不重复的待办 id')
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string}
 */
function normalizeText(value, field, max, code) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TodoError(code, `${field} 必须是字符串`)
  const text = value.trim()
  if (text.length > max) throw new TodoError(code, `${field} 最多 ${max} 个字符`)
  return text
}

/**
 * @param {unknown} value
 * @returns {string | null} canonical ISO-8601 (UTC) or null
 */
export function normalizeDue(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new TodoError('invalid-due', '截止时间必须是 ISO-8601 字符串')
  const text = value.trim()
  if (text === '') return null
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new TodoError('invalid-due', `无法解析截止时间：${value}（用 ISO-8601，例如 2026-10-20T10:00 或 2026-10-20）`)
  }
  return new Date(parsed).toISOString()
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTags(value) {
  if (value === undefined || value === null || value === '') return []
  const list = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(list)) throw new TodoError('invalid-tags', '标签必须是字符串数组或逗号分隔的字符串')
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== 'string') throw new TodoError('invalid-tags', '标签必须是字符串')
    const tag = raw.trim().replace(/^#/, '')
    if (tag === '') continue
    if (tag.length > LIMITS.tag) throw new TodoError('invalid-tags', `单个标签最多 ${LIMITS.tag} 个字符`)
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length > LIMITS.tags) throw new TodoError('invalid-tags', `标签最多 ${LIMITS.tags} 个`)
  }
  return out
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} code
 * @param {string} field
 * @param {string} fallback
 * @returns {string}
 */
function normalizeEnum(value, allowed, code, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw new TodoError(code, `${field} 必须是字符串`)
  const text = value.trim().toLowerCase()
  if (!allowed.includes(text)) {
    throw new TodoError(code, `${field}只能是 ${allowed.join(' / ')}，收到 ${value}`)
  }
  return text
}

/**
 * @param {unknown} value
 * @returns {'human' | 'agent'}
 */
export function normalizeActor(value) {
  return value === 'agent' ? 'agent' : 'human'
}

/**
 * Append one entry to the audit trail, trimming the oldest beyond the limit.
 *
 * @param {object} todo
 * @param {{ kind: string, by?: string, summary?: string, at?: number }} entry
 * @param {number} limit
 */
export function pushActivity(todo, entry, limit = LIMITS.activity) {
  if (!Array.isArray(todo.activity)) todo.activity = []
  todo.activity.push({
    at: entry.at ?? Date.now(),
    by: normalizeActor(entry.by),
    kind: entry.kind,
    ...(entry.summary === undefined || entry.summary === '' ? {} : { summary: entry.summary }),
  })
  while (todo.activity.length > limit) todo.activity.shift()
}

/**
 * Build a fresh record.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {'human' | 'agent'} [options.by]
 * @param {Iterable<string>} [options.usedIds]
 * @param {number} [options.activityLimit]
 * @param {(path: string) => boolean} [options.exists]
 * @param {boolean} [options.requireExistingFiles]
 * @param {{ dir?: string, sessionId?: string }} [options.origin] - where this todo came from
 * @returns {object}
 */
export function createTodo(input, options = {}) {
  const now = options.now ?? Date.now()
  const by = normalizeActor(options.by)
  const raw = input !== null && typeof input === 'object' ? input : {}

  const title = normalizeText(raw.title, '标题', LIMITS.title, 'invalid-title')
  if (title === '') throw new TodoError('invalid-title', '标题不能为空')

  const links = normalizeLinks(raw.links, options)

  const todo = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(options.usedIds ?? []),
    title,
    description: normalizeText(raw.description, '描述', LIMITS.description, 'invalid-description'),
    status: normalizeEnum(raw.status, STATUSES, 'invalid-status', '状态', 'open'),
    priority: normalizeEnum(raw.priority, PRIORITIES, 'invalid-priority', '优先级', 'normal'),
    dueAt: normalizeDue(raw.dueAt ?? raw.due),
    tags: normalizeTags(raw.tags),
    links,
    // An optional plan inside the todo: the steps a person or an agent broke it into.
    // Shipped to the agent as a numbered list, so hand-off stops being one paragraph.
    steps: normalizeSteps(raw.steps),
    // Where it came from, in the author's own words: empty means "typed here".
    evidence: normalizeText(raw.evidence, '原话', LIMITS.evidence, 'invalid-evidence'),
    createdAt: now,
    updatedAt: now,
    createdBy: by,
    updatedBy: by,
    doneAt: null,
    sessionId: '',
    // Where the todo was written from. A hand-off into a *new* session starts in
    // this directory, which is what makes "hand it over" land somewhere useful
    // instead of in a session with no working directory at all.
    originDir: typeof options.origin?.dir === 'string' ? options.origin.dir : '',
    originSessionId: typeof options.origin?.sessionId === 'string' ? options.origin.sessionId : '',
    lastDispatch: null,
    // How it finished: a summary and the artifacts the work produced. Kept
    // beside the status rather than inside it, because "done" alone says
    // nothing about what was done.
    completion: null,
    // Set when an agent finishes something: the person who owns the list confirms it or
    // sends it back. An agent's "done" is a claim, not a decision.
    review: null,
    // An append-only trail of what happened while the todo was open. Unlike the
    // description (the user's own text) this is where an agent reports progress or
    // says it is blocked, so reporting never has to rewrite someone's words.
    notes: [],
    activity: [],
  }
  pushActivity(todo, { kind: 'created', by, at: now, summary: title }, options.activityLimit ?? LIMITS.activity)
  return todo
}

/**
 * @param {unknown} value
 * @param {object} [options] - same options as {@link normalizeLink}
 * @returns {Array<{ kind: 'url' | 'file', value: string, title: string }>}
 */
export function normalizeLinks(value, options = {}) {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value)) throw new TodoError('invalid-link', 'links 必须是数组')
  const out = []
  const seen = new Set()
  for (const item of value) {
    const link = normalizeLink(item, options)
    const key = linkKey(link)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(link)
  }
  return out
}

/**
 * Tolerant load of one stored record. Returns `null` for entries that cannot be
 * salvaged, so a single mangled row never takes the whole list down.
 *
 * @param {unknown} raw
 * @param {object} [options]
 * @param {number} [options.activityLimit]
 * @returns {object | null}
 */
export function normalizeStored(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (id === '' || title === '') return null

  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now()
  const links = []
  if (Array.isArray(raw.links)) {
    for (const item of raw.links) {
      try {
        // Stored links were validated on write; re-validating without the
        // existence probe keeps a since-deleted document attached and visible.
        links.push(normalizeLink(item === null || typeof item !== 'object' ? item : { ...item }))
      } catch {
        /* drop unreadable attachments, keep the todo */
      }
    }
  }

  const todo = {
    id,
    // Human-facing number ("把 #42 交给 Agent"). Assigned by the store from creation
    // order; 0 means "not assigned yet" and is filled in on the next read.
    seq: Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0,
    title,
    description: typeof raw.description === 'string' ? raw.description : '',
    status: STATUSES.includes(raw.status) ? raw.status : 'open',
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    dueAt: (() => {
      try {
        return normalizeDue(raw.dueAt)
      } catch {
        return null
      }
    })(),
    tags: (() => {
      try {
        // Stored data is repaired rather than rejected: keep the readable tags
        // and drop whatever else got in there.
        return normalizeTags(Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : raw.tags)
      } catch {
        return []
      }
    })(),
    links,
    evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, LIMITS.evidence) : '',
    steps: (() => {
      try {
        return normalizeSteps(raw.steps)
      } catch {
        return []
      }
    })(),
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt,
    createdBy: normalizeActor(raw.createdBy),
    updatedBy: normalizeActor(raw.updatedBy),
    doneAt: Number.isFinite(raw.doneAt) ? Number(raw.doneAt) : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    originDir: typeof raw.originDir === 'string' ? raw.originDir : '',
    originSessionId: typeof raw.originSessionId === 'string' ? raw.originSessionId : '',
    lastDispatch: raw.lastDispatch !== null && typeof raw.lastDispatch === 'object' ? raw.lastDispatch : null,
    completion: normalizeCompletion(raw.completion),
    review: normalizeReview(raw.review),
    notes: normalizeNotes(raw.notes),
    activity: Array.isArray(raw.activity)
      ? raw.activity
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.kind === 'string')
          .slice(-(options.activityLimit ?? LIMITS.activity))
          .map((entry) => ({
            at: Number.isFinite(entry.at) ? Number(entry.at) : createdAt,
            by: normalizeActor(entry.by),
            kind: entry.kind,
            ...(typeof entry.summary === 'string' && entry.summary !== '' ? { summary: entry.summary } : {}),
          }))
      : [],
  }
  return todo
}

/**
 * A stored review mark, repaired rather than rejected.
 *
 * Only one shape exists today — an agent finished this and the owner has not answered —
 * so anything else is dropped instead of guessed at.
 *
 * @param {unknown} raw
 * @returns {{ pending: true, at: number, by: string } | null}
 */
function normalizeReview(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.pending !== true) return null
  return {
    pending: true,
    at: Number.isFinite(raw.at) ? Number(raw.at) : Date.now(),
    by: normalizeActor(raw.by),
  }
}

/**
 * Answer the question an agent left behind.
 *
 * Confirm keeps the todo finished and drops the mark; reject puts it back on the list,
 * because "not actually done" is the only honest reading of a rejected claim.
 *
 * @param {object} todo
 * @param {'confirm' | 'reject'} decision
 * @param {{ now?: number, by?: 'human' | 'agent', reason?: string }} [options]
 * @returns {boolean} whether the record changed
 */
export function reviewTodo(todo, decision, options = {}) {
  const now = options.now ?? Date.now()
  const by = normalizeActor(options.by ?? 'human')
  const next = normalizeEnum(decision, ['confirm', 'reject'], 'invalid-decision', '决定', 'confirm')
  if (todo.review === null || todo.review === undefined) return false
  todo.review = null
  todo.updatedAt = now
  todo.updatedBy = by
  const reason = typeof options.reason === 'string' ? options.reason.trim().slice(0, 120) : ''
  if (next === 'reject') {
    todo.status = 'open'
    todo.doneAt = null
    todo.completion = null
    pushActivity(
      todo,
      { kind: 'reopened', by, at: now, summary: reason === '' ? '确认未完成，退回清单' : reason },
      options.activityLimit ?? LIMITS.activity,
    )
    return true
  }
  pushActivity(
    todo,
    { kind: 'reviewed', by, at: now, summary: reason === '' ? '确认完成' : reason },
    options.activityLimit ?? LIMITS.activity,
  )
  return true
}

/**
 * A stored completion record, repaired rather than rejected.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeCompletion(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const artifacts = []
  if (Array.isArray(raw.artifacts)) {
    for (const item of raw.artifacts) {
      try {
        artifacts.push(normalizeLink(item))
      } catch {
        /* drop an unreadable artifact, keep the completion */
      }
    }
  }
  return {
    at: Number.isFinite(raw.at) ? Number(raw.at) : Date.now(),
    by: normalizeActor(raw.by),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    artifacts,
  }
}

/**
 * A stored note trail, repaired rather than rejected.
 *
 * @param {unknown} raw
 * @returns {{ at: number, by: string, text: string }[]}
 */
function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return []
  const notes = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    notes.push({
      at: Number.isFinite(item.at) ? Number(item.at) : Date.now(),
      by: normalizeActor(item.by),
      text: item.text.slice(0, LIMITS.note),
    })
  }
  return notes.slice(-LIMITS.notes)
}

/**
 * Append a note.
 *
 * The trail is capped rather than unbounded: a hand-off loop that reports every
 * few minutes must not turn one record into a log file.
 *
 * @param {object} todo
 * @param {string} text
 * @param {{ by?: 'human' | 'agent', now?: number, activityLimit?: number }} [options]
 * @returns {{ at: number, by: string, text: string }}
 */
export function addNote(todo, text, options = {}) {
  const now = options.now ?? Date.now()
  const by = normalizeActor(options.by)
  const note = {
    at: now,
    by,
    text: normalizeText(text, '进展内容', LIMITS.note, 'invalid-description'),
  }
  const existing = Array.isArray(todo.notes) ? todo.notes : []
  todo.notes = [...existing, note].slice(-LIMITS.notes)
  todo.updatedAt = now
  todo.updatedBy = by
  pushActivity(
    todo,
    { kind: 'noted', by, at: now, summary: note.text.slice(0, 120) },
    options.activityLimit ?? LIMITS.activity,
  )
  return note
}

/**
 * Mark a todo finished, with evidence.
 *
 * @param {object} todo
 * @param {{ summary?: string, artifacts?: unknown[], sessionId?: string }} evidence
 * @param {object} [options]
 * @returns {boolean} whether the record changed
 */
export function completeTodo(todo, evidence = {}, options = {}) {
  const now = options.now ?? Date.now()
  const by = normalizeActor(options.by ?? 'agent')
  const summary = normalizeText(evidence.summary, '完成说明', LIMITS.description, 'invalid-description')
  // An artifact is a claim about what the work produced, not an attachment the
  // user is adding: a file that has since moved, or one outside the store's
  // reach, must not cost the record its completion.
  const artifacts = normalizeLinks(evidence.artifacts, { ...options, requireExistingFiles: false })
  const alreadyDone = todo.status === 'done'
  todo.status = 'done'
  todo.doneAt = now
  todo.updatedAt = now
  todo.updatedBy = by
  todo.review = by === 'agent' ? { pending: true, at: now, by } : null
  todo.completion = {
    at: now,
    by,
    summary,
    sessionId: typeof evidence.sessionId === 'string' ? evidence.sessionId : '',
    artifacts,
  }
  pushActivity(
    todo,
    {
      kind: 'completed',
      by,
      at: now,
      summary: summary === '' ? (artifacts.length > 0 ? `${artifacts.length} 个产出` : '已完成') : summary.slice(0, 120),
    },
    options.activityLimit ?? LIMITS.activity,
  )
  return !alreadyDone
}

/**
 * Apply a partial update. Unknown keys are ignored; `undefined` means "leave it".
 *
 * @param {object} todo
 * @param {object} patch
 * @param {object} [options]
 * @returns {string[]} names of the fields that actually changed
 */
export function applyPatch(todo, patch, options = {}) {
  if (patch === null || typeof patch !== 'object') {
    throw new TodoError('invalid-body', 'patch 必须是对象')
  }
  const now = options.now ?? Date.now()
  const by = normalizeActor(options.by)
  const changed = []

  if (patch.title !== undefined) {
    const title = normalizeText(patch.title, '标题', LIMITS.title, 'invalid-title')
    if (title === '') throw new TodoError('invalid-title', '标题不能为空')
    if (title !== todo.title) {
      todo.title = title
      changed.push('title')
    }
  }
  if (patch.description !== undefined) {
    const description = normalizeText(patch.description, '描述', LIMITS.description, 'invalid-description')
    if (description !== todo.description) {
      todo.description = description
      changed.push('description')
    }
  }
  if (patch.priority !== undefined) {
    const priority = normalizeEnum(patch.priority, PRIORITIES, 'invalid-priority', '优先级', todo.priority)
    if (priority !== todo.priority) {
      todo.priority = priority
      changed.push('priority')
    }
  }
  if (patch.dueAt !== undefined || patch.due !== undefined) {
    const dueAt = normalizeDue(patch.dueAt ?? patch.due)
    if (dueAt !== todo.dueAt) {
      todo.dueAt = dueAt
      changed.push('dueAt')
    }
  }
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags)
    if (tags.join('\u0000') !== todo.tags.join('\u0000')) {
      todo.tags = tags
      changed.push('tags')
    }
  }
  if (patch.evidence !== undefined) {
    const evidence = normalizeText(patch.evidence, '原话', LIMITS.evidence, 'invalid-evidence')
    if (evidence !== todo.evidence) {
      todo.evidence = evidence
      changed.push('evidence')
    }
  }
  if (patch.steps !== undefined) {
    const steps = normalizeSteps(patch.steps)
    const same =
      steps.length === todo.steps.length && steps.every((step, index) => step.text === todo.steps[index].text && step.done === todo.steps[index].done)
    if (!same) {
      todo.steps = steps
      changed.push('steps')
    }
  }
  if (patch.status !== undefined) {
    const status = normalizeEnum(patch.status, STATUSES, 'invalid-status', '状态', todo.status)
    if (status !== todo.status) {
      todo.status = status
      todo.doneAt = status === 'done' ? now : null
      // Reaching done through a patch carries the same review rule as the dedicated
      // status path: an agent's "done" is a claim, a person's is a decision.
      todo.review = status === 'done' && by === 'agent' ? { pending: true, at: now, by } : null
      changed.push('status')
    }
  }
  if (patch.links !== undefined) {
    const links = normalizeLinks(patch.links, options)
    if (links.length !== todo.links.length || links.some((link, index) => linkKey(link) !== linkKey(todo.links[index]))) {
      todo.links = links
      changed.push('links')
    }
  }

  if (changed.length > 0) {
    todo.updatedAt = now
    todo.updatedBy = by
    pushActivity(
      todo,
      { kind: 'updated', by, at: now, summary: changed.join(', ') },
      options.activityLimit ?? LIMITS.activity,
    )
  }
  return changed
}

/**
 * @param {object} todo
 * @param {string} status
 * @param {object} [options]
 * @param {string} [options.reason] - why the status changed. When given it becomes the
 *   activity entry's summary, so the trail says more than "it was set to open".
 * @returns {boolean} whether anything changed
 */
export function setStatus(todo, status, options = {}) {
  const now = options.now ?? Date.now()
  const by = normalizeActor(options.by)
  const next = normalizeEnum(status, STATUSES, 'invalid-status', '状态', todo.status)
  if (next === todo.status) return false
  todo.status = next
  todo.doneAt = next === 'done' ? now : null
  // A completion record describes a finished job, so reopening clears it: a
  // record that still claims the work is done is worse than no record.
  if (next !== 'done') todo.completion = null
  // Who finished it decides whether a person still has to agree: an agent's "done" is a
  // claim, the owner's is a decision. Leaving done drops the mark with the record.
  todo.review = next === 'done' && by === 'agent' ? { pending: true, at: now, by } : null
  todo.updatedAt = now
  todo.updatedBy = by
  const kind = next === 'done' ? 'done' : next === 'open' ? 'reopened' : 'status'
  // The status already lives in the entry's `kind`; a stated reason is the part a
  // person reading the trail afterwards cannot reconstruct.
  const reason = typeof options.reason === 'string' ? options.reason.trim().slice(0, 120) : ''
  pushActivity(
    todo,
    { kind, by, at: now, summary: reason === '' ? next : next + '：' + reason },
    options.activityLimit ?? LIMITS.activity,
  )
  return true
}

/**
 * An optional plan inside a todo.
 *
 * A step is text plus a tick, and the order is the plan. Strings are accepted for the
 * common case (create, or an agent rewriting the plan) so a caller never has to spell out
 * `{ done: false }` for every line.
 *
 * @param {unknown} value
 * @returns {Array<{ text: string, done: boolean }>}
 */
export function normalizeSteps(value) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new TodoError('invalid-steps', '步骤必须是数组')
  if (value.length > LIMITS.steps) {
    throw new TodoError('invalid-steps', `步骤最多 ${LIMITS.steps} 条，收到 ${value.length} 条`)
  }
  const out = []
  for (const item of value) {
    if (typeof item === 'string') {
      const text = item.trim().slice(0, LIMITS.step)
      // A blank line in a textarea is a typo, not a step.
      if (text !== '') out.push({ text, done: false })
      continue
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TodoError('invalid-steps', '步骤必须是字符串或 { text, done }')
    }
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, LIMITS.step) : ''
    if (text === '') continue
    out.push({ text, done: item.done === true })
  }
  return out
}

/**
 * @param {object} todo
 * @param {unknown} link
 * @param {object} [options]
 * @returns {{ added: boolean, link: object }}
 */
export function addLink(todo, link, options = {}) {
  const normalized = normalizeLink(link, options)
  const key = linkKey(normalized)
  if (todo.links.some((existing) => linkKey(existing) === key)) {
    return { added: false, link: normalized }
  }
  todo.links.push(normalized)
  const now = options.now ?? Date.now()
  todo.updatedAt = now
  todo.updatedBy = normalizeActor(options.by)
  pushActivity(
    todo,
    {
      kind: 'linked',
      by: options.by,
      at: now,
      summary: `${normalized.kind === 'url' ? '地址' : '文档'} ${normalized.title}`,
    },
    options.activityLimit ?? LIMITS.activity,
  )
  return { added: true, link: normalized }
}

/**
 * Remove by identity (`key`) or by 0-based index.
 *
 * @param {object} todo
 * @param {{ key?: string, index?: number }} ref
 * @param {object} [options]
 * @returns {object | null} the removed link, or null when nothing matched
 */
export function removeLink(todo, ref, options = {}) {
  let index = -1
  if (Number.isInteger(ref?.index)) {
    index = ref.index >= 0 && ref.index < todo.links.length ? ref.index : -1
  } else if (typeof ref?.key === 'string' && ref.key !== '') {
    index = todo.links.findIndex((link) => linkKey(link) === ref.key)
  }
  if (index < 0) return null
  const [removed] = todo.links.splice(index, 1)
  const now = options.now ?? Date.now()
  todo.updatedAt = now
  todo.updatedBy = normalizeActor(options.by)
  pushActivity(
    todo,
    { kind: 'unlinked', by: options.by, at: now, summary: removed.title },
    options.activityLimit ?? LIMITS.activity,
  )
  return removed
}

/**
 * Remember which session this todo is handed to, and how that went.
 *
 * @param {object} todo
 * @param {{ mode: string, sessionId?: string, ok: boolean, error?: string }} info
 * @param {object} [options]
 */
export function recordDispatch(todo, info, options = {}) {
  const now = options.now ?? Date.now()
  const sessionId = typeof info.sessionId === 'string' ? info.sessionId : ''
  todo.lastDispatch = {
    at: now,
    mode: info.mode,
    ok: info.ok === true,
    ...(sessionId === '' ? {} : { sessionId }),
    ...(typeof info.dir === 'string' && info.dir !== '' ? { dir: info.dir } : {}),
    ...(typeof info.error === 'string' && info.error !== '' ? { error: info.error } : {}),
  }
  if (info.ok === true && sessionId !== '') todo.sessionId = sessionId
  todo.updatedAt = now
  todo.updatedBy = normalizeActor(options.by ?? 'human')
  pushActivity(
    todo,
    {
      kind: info.ok === true ? 'dispatched' : 'dispatch-failed',
      by: options.by ?? 'human',
      at: now,
      summary: info.ok === true ? `${info.mode} → ${sessionId}` : `${info.mode}：${info.error ?? '未知原因'}`,
    },
    options.activityLimit ?? LIMITS.activity,
  )
}

/**
 * @param {object} todo
 * @param {number} [now]
 * @returns {boolean}
 */
export function isOverdue(todo, now = Date.now()) {
  if (todo.dueAt === null || todo.status === 'done' || todo.status === 'cancelled' || todo.status === 'archived') return false
  const due = Date.parse(todo.dueAt)
  return Number.isFinite(due) && due < now
}

/**
 * @param {object[]} todos
 * @returns {{ total: number, open: number, doing: number, done: number, cancelled: number, archived: number, overdue: number }}
 */
export function counts(todos, now = Date.now()) {
  const out = {
    total: todos.length,
    open: 0,
    doing: 0,
    done: 0,
    cancelled: 0,
    archived: 0,
    overdue: 0,
    inbox: 0,
    // Finished by an agent and not yet confirmed by a person. Counted separately from
    // done because "the agent says so" is not the same fact as "a person agreed".
    review: 0,
  }
  for (const todo of todos) {
    if (todo.status in out) out[todo.status] += 1
    if (isOverdue(todo, now)) out.overdue += 1
    // Waiting for a person counts only while it is still active; an archived inbox item is
    // history, not a pending decision.
    if ((todo.status === 'open' || todo.status === 'doing') && (todo.tags ?? []).some((tag) => tag.toLowerCase() === 'inbox')) {
      out.inbox += 1
    }
    if (todo.status === 'done' && todo.review?.pending === true) out.review += 1
  }
  return out
}

export { LINK_KINDS }
