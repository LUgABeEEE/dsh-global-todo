/**
 * What the agents did, this week.
 *
 * The per-todo completion record already holds the facts: who finished it, what they said,
 * and which files the work produced. This turns those records into the one page a person
 * actually asks for — "what moved, and did any of it land in code" — without inventing a
 * second source of truth: everything here is derived from `completion`, `doneAt` and
 * `review`.
 *
 * Pure and time-explicit: the caller passes `now`, so a test never depends on the clock.
 */

import { buildTriage, classify, isSnoozed } from './triage.js'

/** How many files are listed before the tail is summarised. */
const FILE_LIMIT = 12

/**
 * @param {object[]} todos
 * @param {{ now?: number, days?: number }} [options]
 * @returns {{
 *   since: number,
 *   days: number,
 *   finished: object[],
 *   created: number,
 *   sessions: number,
 *   files: Array<{ path: string, count: number, titles: string[] }>,
 *   pendingReview: number,
 * }}
 */
export function weeklyReport(todos, options = {}) {
  const now = options.now ?? Date.now()
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.min(options.days, 90) : 7
  const since = now - days * 24 * 60 * 60 * 1000
  const list = Array.isArray(todos) ? todos : []

  // The current shape of the list, from the same rules the tick uses. A report that invented
  // its own bucket logic would be a second opinion about the same records.
  const triage = buildTriage(list, { now })
  const incomingNow = { decision: 0, self: 0, external: 0, unknown: 0 }
  const incomingPrev = { decision: 0, self: 0, external: 0, unknown: 0 }
  const previousStart = since - days * 24 * 60 * 60 * 1000
  let staleDecisions = 0
  let oldestDecisionDays = 0

  const finished = []
  let created = 0
  const sessions = new Set()
  const files = new Map()
  let pendingReview = 0

  for (const todo of list) {
    if (typeof todo.createdAt === 'number' && todo.createdAt >= since) created += 1

    // What kind of work arrived, this week and the week before: a backlog that is mostly
    // 「该你一句话」 is a decision problem, and one that is mostly 「等外部」 is not a problem at
    // all — the two look identical in a raw "created N" count.
    const createdAt = Number(todo.createdAt)
    if (Number.isFinite(createdAt) && createdAt >= previousStart) {
      const bucket = classify(todo).bucket
      if (createdAt >= since) incomingNow[bucket] += 1
      else incomingPrev[bucket] += 1
    }

    // How old the decisions are. A list can hold the same 50 decisions for months and look
    // busy while nothing that needs a person ever gets answered.
    if ((todo.status === 'open' || todo.status === 'doing') && isSnoozed(todo, now) === false) {
      if (classify(todo).bucket === 'decision' && Number.isFinite(createdAt)) {
        const age = (now - createdAt) / (24 * 60 * 60 * 1000)
        if (age > 14) staleDecisions += 1
        if (age > oldestDecisionDays) oldestDecisionDays = Math.floor(age)
      }
    }
    if (todo.status === 'done' && todo.review?.pending === true) pendingReview += 1
    const completion = todo.completion
    if (completion === null || completion === undefined) continue
    const at = Number.isFinite(completion.at) ? completion.at : todo.doneAt
    if (!Number.isFinite(at) || at < since) continue

    const artifacts = Array.isArray(completion.artifacts) ? completion.artifacts : []
    finished.push({
      id: todo.id,
      seq: todo.seq ?? 0,
      title: todo.title,
      at,
      by: completion.by,
      summary: completion.summary ?? '',
      sessionId: completion.sessionId ?? '',
      reviewPending: todo.review?.pending === true,
      artifacts: artifacts.slice(0, 5).map((link) => ({ kind: link.kind, value: link.value, title: link.title })),
      artifactCount: artifacts.length,
    })

    if (typeof completion.sessionId === 'string' && completion.sessionId !== '') sessions.add(completion.sessionId)
    for (const link of artifacts) {
      if (link?.kind !== 'file') continue
      const path = String(link.value ?? '')
      if (path === '') continue
      const entry = files.get(path) ?? { path, count: 0, titles: [] }
      entry.count += 1
      if (entry.titles.length < 3) entry.titles.push(todo.title)
      files.set(path, entry)
    }
  }

  finished.sort((a, b) => b.at - a.at)
  const topFiles = [...files.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))

  return {
    since,
    days,
    finished,
    created,
    sessions: sessions.size,
    files: topFiles.slice(0, FILE_LIMIT),
    fileCount: topFiles.length,
    pendingReview,
    // Derived, never stored: the same list answers "what moved" and "what is piling up".
    triage: {
      counts: triage.counts,
      buckets: triage.buckets,
      incoming: { now: incomingNow, prev: incomingPrev },
      decisionBacklog: { stale: staleDecisions, oldestDays: oldestDecisionDays },
    },
  }
}
