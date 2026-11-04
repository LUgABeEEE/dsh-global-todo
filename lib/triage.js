/**
 * Daily triage: which records deserve attention, and who has to move.
 *
 * The list knows *what* is open; it never knew *why* a record is still open, and that is the
 * only question that decides whether the next move is a person's, an agent's, or nobody's
 * until something outside changes. Answering it with a model per record would cost a call
 * per record per day; answering it with rules costs nothing and can explain itself, which is
 * what makes a wrong answer fixable.
 *
 * Everything here is pure: no clock, no filesystem, no network. The 09:45 tick, the panel and
 * the tests must reach the same verdict from the same record, or the bucket counts become
 * three different opinions about one list.
 *
 * The vocabulary is inherited from the read-only `triage.py` that preceded this module — a
 * second implementation of the same rules is how the two drift, so the script should read this
 * module's output rather than keeping its own copy of the words.
 *
 * @module dsh-global-todo/triage
 */

import { CHASE_MARK, SNOOZE_MARK } from './marks.js'
import { isInbox } from './model.js'

/**
 * Four answers, and only four.
 *
 * `decision` is the expensive one: it cannot move without a person. `self` is an agent's,
 * `external` is waiting on something nobody here controls, and `unknown` is the honest
 * remainder — a record nobody has judged yet, which is why the panel must never hide that
 * count behind a percentage.
 */
export const BUCKETS = Object.freeze(['decision', 'self', 'external', 'unknown'])

/** Chinese labels, because a note on the list is read by a person, not by the panel. */
export const BUCKET_LABELS = Object.freeze({
  decision: '该你一句话',
  self: '可自决',
  external: '等外部',
  unknown: '待判',
})

/**
 * Phrases that mean "a person has to say something".
 *
 * Ported verbatim from `triage.py` on purpose: changing the vocabulary changes the bucket
 * counts a person has been reading every morning, and that comparison is the only way to tell
 * a real backlog from a reclassification.
 */
const NEED_YOU = ['确认', '二选一', '你定', '需要你', '等你', '请用户', '待确认', '给个说法', '决定']

/** Phrases that mean "waiting on the world", which is not the same as "being ignored". */
const WAIT_EXTERNAL = ['等回复', '等对方', '等证书', '到账', '外部', '窗口', '等通知', '等宿主', '上游']

/**
 * Verbs an agent can carry out without asking.
 *
 * Deliberately narrow: these are maintenance-shaped errands (整理/复核/归档). A record that
 * merely contains a verb is still only a *candidate* — the dispatch gate decides whether it
 * may actually be handed over, and that gate is a separate module precisely so this list can
 * stay generous without turning the list into an autopilot.
 */
const AUTO_OK = ['整理', '复跑', '复核', '同步', '补测', '归档', '清点', '更新文档', '写进', '登记']

/** Tag overrides. An explicit tag beats any phrase in the text, in both directions. */
const TAG_DECISION = '需决策'
const TAG_EXTERNAL = '等外部'
const TAG_AUTO = '可自动'

/**
 * The three tags, exported so the dispatch gate reads the same spelling.
 *
 * A second literal for 「可自动」 in `lib/gate.js` is how a rename becomes "the tag exists but
 * nothing matches it", which looks like a policy refusing everything.
 */
export const CLASSIFY_TAGS = Object.freeze({ decision: TAG_DECISION, external: TAG_EXTERNAL, auto: TAG_AUTO })

/**
 * A deferral mark, written as a note.
 *
 * The list already has one ledger (the notes) for things that happen to a record; a snooze is
 * another such thing, so it goes there instead of into a new column. That also makes it
 * reversible by reading: the newest mark wins, and a mark dated in the future means "not today".
 * A second field would need a model migration, a sync rule and a panel control to say the same.
 */
// Re-exported so callers keep importing the mark from the module whose rules use it.
export { SNOOZE_MARK }

/** @type {RegExp} the day a deferral note points at */
const SNOOZE_PATTERN = /【推迟\s*(\d{4}-\d{2}-\d{2})】/

/**
 * When this record asked to be left alone, and until when.
 *
 * Latest mark wins: clicking "three days" after "tomorrow" must extend, not be ignored.
 *
 * @param {object} todo
 * @returns {{ until: string, at: number } | null}
 */
export function snoozeOf(todo) {
  const notes = Array.isArray(todo?.notes) ? todo.notes : []
  let found = null
  for (const note of notes) {
    const text = typeof note?.text === 'string' ? note.text : ''
    if (!text.startsWith(SNOOZE_MARK)) continue
    const match = text.match(SNOOZE_PATTERN)
    if (match === null) continue
    const at = Number(note.at)
    if (found === null || (Number.isFinite(at) && at >= found.at)) found = { until: match[1], at: Number.isFinite(at) ? at : 0 }
  }
  return found
}

/**
 * Is this record deferred past today?
 *
 * Compared by local calendar day, like the budget: "until the 5th" means the whole 5th is off.
 *
 * @param {object} todo
 * @param {number} now
 * @returns {boolean}
 */
export function isSnoozed(todo, now = Date.now()) {
  const snooze = snoozeOf(todo)
  if (snooze === null) return false
  return snooze.until >= localDay(now)
}

/**
 * A local calendar day, `YYYY-MM-DD`.
 *
 * Duplicated from `lib/gate.js` on purpose: `triage.js` is imported by the gate, so importing
 * back would close the cycle. One line beats a shared module for one line.
 *
 * @param {number} at
 * @returns {string}
 */
export function localDay(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A chase mark: "I nudged the other side today".
 *
 * The 「等外部」 bucket is the one that rots silently: nobody is wrong, nothing is late, and the
 * only question that matters is "when did I last ask". A note answers it, like every other
 * event on a record, and it is the only trace that survives the other side not answering.
 */
export { CHASE_MARK }

/** @type {RegExp} the day a chase note was written for */
const CHASE_PATTERN = /【催办\s*(\d{4}-\d{2}-\d{2})】/

/**
 * When this record was last chased, and how long ago that was.
 *
 * @param {object} todo
 * @param {number} now
 * @returns {{ at: number, day: string, days: number } | null}
 */
export function lastChase(todo, now = Date.now()) {
  const notes = Array.isArray(todo?.notes) ? todo.notes : []
  let found = null
  for (const note of notes) {
    const text = typeof note?.text === 'string' ? note.text : ''
    if (!text.startsWith(CHASE_MARK)) continue
    const match = text.match(CHASE_PATTERN)
    const at = Number(note.at)
    if (match === null || !Number.isFinite(at)) continue
    if (found === null || at >= found.at) found = { at, day: match[1] }
  }
  if (found === null) return null
  return { at: found.at, day: found.day, days: Math.max(0, Math.floor((now - found.at) / 86_400_000)) }
}

/** How many records the router is allowed to put in front of a person per day. */
export const TOP_COUNT = 3

const round2 = (value) => Math.round(value * 100) / 100

/**
 * @param {object} todo
 * @returns {string[]} its tags, lowercased, or an empty list
 */
function tagsOf(todo) {
  return Array.isArray(todo?.tags) ? todo.tags.map((tag) => String(tag).toLowerCase()) : []
}

/**
 * Which of the four answers this record belongs to, and why.
 *
 * A tag wins over the text: a person who wrote 「可自动」 has stated an intent that a
 * coincidental 「确认」 in the description must not override.
 *
 * @param {object} todo
 * @returns {{ bucket: string, matched: string, by: 'tag' | 'text' | 'none' }}
 */
export function classify(todo) {
  const tags = tagsOf(todo)
  if (tags.includes(TAG_AUTO.toLowerCase())) return { bucket: 'self', matched: TAG_AUTO, by: 'tag' }
  if (tags.includes(TAG_EXTERNAL.toLowerCase())) return { bucket: 'external', matched: TAG_EXTERNAL, by: 'tag' }
  if (tags.includes(TAG_DECISION.toLowerCase())) return { bucket: 'decision', matched: TAG_DECISION, by: 'tag' }

  const text = `${todo?.title ?? ''} ${todo?.description ?? ''}`
  const found = (words) => words.find((word) => text.includes(word))
  // The order is the whole rule: a record that needs a person is never filed as waiting.
  const decision = found(NEED_YOU)
  if (decision !== undefined) return { bucket: 'decision', matched: decision, by: 'text' }
  const external = found(WAIT_EXTERNAL)
  if (external !== undefined) return { bucket: 'external', matched: external, by: 'text' }
  const auto = found(AUTO_OK)
  if (auto !== undefined) return { bucket: 'self', matched: auto, by: 'text' }
  return { bucket: 'unknown', matched: '', by: 'none' }
}

/**
 * How loud this record is today, and the named reasons.
 *
 * Every contribution is a sentence a person could argue with — that is the point of returning
 * them instead of a bare number. The same weights as `triage.py`, expressed in epoch ms because
 * that is what this store writes.
 *
 * @param {object} todo
 * @param {number} [now]
 * @returns {{ score: number, why: string[] }}
 */
export function scoreTodo(todo, now = Date.now()) {
  let score = 0
  const why = []

  const due = todo?.dueAt === null || todo?.dueAt === undefined ? Number.NaN : Date.parse(todo.dueAt)
  if (Number.isFinite(due)) {
    const days = (now - due) / 86_400_000
    if (days >= 0) {
      score += 3 + Math.min(days, 14) * 0.2
      why.push(`逾期 ${Math.floor(days)} 天`)
    } else if (days > -3) {
      score += 2
      // 「0 天内到期」 reads like a bug; a deadline later today is 「今天到期」.
      why.push(days > -1 ? '今天到期' : `${Math.ceil(Math.abs(days))} 天内到期`)
    }
  }

  const priorityBonus = { urgent: 3, high: 2, normal: 0, low: -1 }
  const bonus = priorityBonus[todo?.priority] ?? 0
  if (bonus !== 0) {
    score += bonus
    why.push(`优先级 ${todo.priority}`)
  }

  // A record nobody has touched in two weeks is either forgotten or blocked; both are louder
  // than their deadline alone would say.
  const updated = Number(todo?.updatedAt)
  if (Number.isFinite(updated) && updated > 0) {
    const idle = (now - updated) / 86_400_000
    if (idle > 14) {
      score += 1
      why.push(`静置 ${Math.floor(idle)} 天`)
    }
  }

  const steps = Array.isArray(todo?.steps) ? todo.steps : []
  if (steps.some((step) => step?.done !== true)) {
    score += 0.5
    why.push('有未完成步骤')
  }

  // A hand-off three days old is still "in progress" even when the session went quiet; keeping
  // it at the top would push the person to re-dispatch a live task.
  const dispatchedAt = Number(todo?.lastDispatch?.at)
  if (Number.isFinite(dispatchedAt) && dispatchedAt > 0) {
    const recent = (now - dispatchedAt) / 86_400_000
    if (recent < 3) {
      score -= 2
      why.push(`${Math.floor(recent)} 天前刚派过`)
    }
  }

  return { score: round2(score), why }
}

/**
 * The whole list, judged once.
 *
 * @param {object[]} todos - every stored record
 * @param {{ now?: number, top?: number }} [options]
 * @returns {{
 *   generatedAt: number,
 *   counts: { active: number, overdue: number, inbox: number, review: number },
 *   buckets: Record<string, number>,
 *   rows: object[],
 *   today: object[],
 * }}
 */
export function buildTriage(todos, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const top = Number.isInteger(options.top) && options.top > 0 ? options.top : TOP_COUNT
  const all = Array.isArray(todos) ? todos : []

  const counts = { active: 0, overdue: 0, inbox: 0, review: 0, snoozed: 0 }
  const rows = []
  for (const todo of all) {
    if (todo === null || typeof todo !== 'object') continue
    if (todo.status === 'done' && todo.review?.pending === true) counts.review += 1
    // The inbox is a question for a person, not work on the list: filing those records under
    // 「该你一句话」 would turn 40 unconfirmed captures into 40 daily decisions.
    if (isInbox(todo)) {
      // Only a *waiting* inbox record is a pending question; an archived one is history, and
      // counting it would inflate the number the panel shows against the filter's own count.
      if (todo.status === 'open' || todo.status === 'doing') counts.inbox += 1
      continue
    }
    if (todo.status !== 'open' && todo.status !== 'doing') continue
    // A deferred record is still active — the count says so — but it is not today's business,
    // which is the only thing this report is about.
    if (isSnoozed(todo, now)) {
      counts.active += 1
      counts.snoozed += 1
      continue
    }
    counts.active += 1

    const verdict = classify(todo)
    const { score, why } = scoreTodo(todo, now)
    const overdue = Number.isFinite(Date.parse(todo.dueAt))
    if (overdue && Date.parse(todo.dueAt) < now) counts.overdue += 1

    const steps = Array.isArray(todo.steps) ? todo.steps : []
    // Only the external bucket needs it: "when did I last ask" is meaningless for work that is
    // nobody else's to unblock.
    const chase = verdict.bucket === 'external' ? lastChase(todo, now) : null
    rows.push({
      id: todo.id,
      seq: todo.seq,
      title: todo.title,
      bucket: verdict.bucket,
      bucketWhy: verdict.matched,
      score,
      why,
      priority: todo.priority,
      dueAt: todo.dueAt,
      dispatched: Number.isFinite(Number(todo.lastDispatch?.at)) && Number(todo.lastDispatch?.at) > 0,
      stepsPending: steps.filter((step) => step?.done !== true).length,
      chaseDays: chase === null ? null : chase.days,
    })
  }

  // Ties are common (most records have no deadline and no priority), so the fallback order has
  // to be a fact about the record rather than the order the file happened to store it in.
  rows.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const dueLeft = left.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.dueAt)
    const dueRight = right.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.dueAt)
    if (dueLeft !== dueRight) return dueLeft - dueRight
    return (left.seq ?? 0) - (right.seq ?? 0)
  })

  const buckets = { decision: 0, self: 0, external: 0, unknown: 0 }
  for (const row of rows) buckets[row.bucket] += 1

  return {
    generatedAt: now,
    counts,
    buckets,
    rows,
    // The day's three: the whole point of a budget is that it is short enough to finish.
    today: rows.slice(0, top).map((row) => ({
      id: row.id,
      seq: row.seq,
      title: row.title,
      bucket: row.bucket,
      score: row.score,
      why: row.why,
    })),
  }
}
