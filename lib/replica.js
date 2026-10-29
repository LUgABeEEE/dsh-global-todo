/**
 * One list on several machines.
 *
 * The store is one JSON file per machine; a second machine cannot share it without
 * copying it. Copying a whole document is only safe when the two sides can be folded back
 * together without losing a record, which needs three facts this module owns:
 *
 *  - **A delete has to leave a mark.** `remove` used to drop the record, so the next copy
 *    from a machine that still had it put it back — from the other side it looked like the
 *    delete simply had not happened. Every removal now leaves a tombstone
 *    (`{ id, at, by }`) that travels with the document.
 *  - **The newer write wins, per record.** Two machines editing *different* todos is the
 *    common case; two editing *the same* todo is rare, and last-writer-wins on
 *    `updatedAt` is the only rule that can be applied without asking somebody a question
 *    they cannot answer ("which of these two edits did you mean?").
 *  - **The numbering is a function of the set.** `seq` is what people quote ("把 #42 交给
 *    Agent"), so two machines that were offline at the same time must not both hand out
 *    #332. `assignSequence` numbers from the records themselves, so both sides reach the
 *    same numbers without coordinating.
 *
 * The fold is commutative, associative and idempotent: `merge(a, b)` and `merge(b, a)`
 * produce the same list, only the reported changes swap sides. That is what lets three
 * machines sync in any order, retry a half-failed sync, and still converge.
 *
 * What it deliberately cannot do:
 *
 *  - merge two edits *inside* one record (a tag added on A, a priority changed on B — one
 *    of the two is lost, the later `updatedAt` decides);
 *  - revive a delete older than {@link TOMBSTONE_TTL_MS} (a machine that was offline for a
 *    year is indistinguishable from a machine holding a file nobody wants back);
 *  - resolve a clock that jumped forward. `updatedAt` is wall-clock time from each device.
 *
 * @module dsh-global-todo/replica
 */

import { SCHEMA_VERSION, assignSequence } from './model.js'

/**
 * How long a deletion is remembered.
 *
 * A tombstone costs about 80 bytes, so a year of deletions is cheaper than one resurrected
 * todo. The trade-off is deliberate: after this long, a copy that still contains the
 * record wins again.
 */
export const TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** A bound on the tombstone list, so a script that deletes in a loop cannot grow the file. */
export const TOMBSTONE_LIMIT = 5000

/**
 * Read the tombstone list out of a stored document, repairing instead of rejecting.
 *
 * Kept entries are newest-first and unique by id: the same id deleted twice keeps the
 * later deletion, because that is the one that has to outlive copies made before it.
 *
 * @param {unknown} raw
 * @param {{ limit?: number }} [options]
 * @returns {{ id: string, at: number, by: 'human' | 'agent' }[]}
 */
export function normalizeTrash(raw, options = {}) {
  const limit = options.limit ?? TOMBSTONE_LIMIT
  const entries = Array.isArray(raw) ? raw : []
  const byId = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const at = Number(entry.at)
    if (id === '' || !Number.isFinite(at) || at <= 0) continue
    const previous = byId.get(id)
    if (previous !== undefined && previous.at >= at) continue
    byId.set(id, { id, at, by: entry.by === 'agent' ? 'agent' : 'human' })
  }
  return [...byId.values()].sort((left, right) => right.at - left.at || left.id.localeCompare(right.id)).slice(0, limit)
}

/**
 * Add one deletion, keeping the list bounded and unique.
 *
 * @param {{ id: string, at: number, by?: 'human' | 'agent' }[]} trash
 * @param {{ id: string, at: number, by?: 'human' | 'agent' }} entry
 * @param {{ limit?: number }} [options]
 * @returns {{ id: string, at: number, by: 'human' | 'agent' }[]}
 */
export function pushTombstone(trash, entry, options = {}) {
  const next = normalizeTrash([...(Array.isArray(trash) ? trash : []), entry], options)
  return next
}

/**
 * Forget that a record was deleted — what an undo has to do.
 *
 * Restoring a record without this leaves the tombstone behind, and the next fold deletes
 * the restored copy again: the undo would work until the next sync, which is worse than
 * not working at all.
 *
 * @param {{ id: string, at: number }[]} trash
 * @param {string} id
 * @returns {{ id: string, at: number }[]}
 */
export function forgetTombstone(trash, id) {
  return normalizeTrash(Array.isArray(trash) ? trash.filter((entry) => entry.id !== id) : [])
}

/**
 * An empty document that still declares the current schema.
 *
 * @returns {{ version: number, todos: object[], trash: object[] }}
 */
export function emptyDocument() {
  return { version: SCHEMA_VERSION, todos: [], trash: [] }
}

/** @param {unknown} value */
function canonical(value) {
  return JSON.stringify(value)
}

/**
 * Pick the winning copy of one id.
 *
 * `updatedAt` first (the point of last-writer-wins), then the larger canonical JSON as a
 * tie-break — two machines can stamp the same millisecond, and the tie has to resolve the
 * same way on both sides or the fold is not idempotent. Comparing the content itself is
 * arbitrary but stable, which is all a tie-break needs to be.
 *
 * @param {object} left
 * @param {object} right
 * @returns {object}
 */
function newer(left, right) {
  const leftAt = Number(left.updatedAt) || 0
  const rightAt = Number(right.updatedAt) || 0
  if (leftAt !== rightAt) return leftAt > rightAt ? left : right
  return canonical(left) >= canonical(right) ? left : right
}

/**
 * Fold two documents into one.
 *
 * @param {{ todos?: object[], trash?: object[] } | null | undefined} left - usually the local list
 * @param {{ todos?: object[], trash?: object[] } | null | undefined} right - usually the other machine's
 * @param {{ now?: number, tombstoneTtlMs?: number, tombstoneLimit?: number }} [options]
 * @returns {{ version: number, todos: object[], trash: object[], stats: Record<string, number> }}
 */
export function mergeDocuments(left, right, options = {}) {
  const now = options.now ?? Date.now()
  const ttl = options.tombstoneTtlMs ?? TOMBSTONE_TTL_MS
  const limit = options.tombstoneLimit ?? TOMBSTONE_LIMIT

  /** @type {Map<string, object>} */
  const chosen = new Map()
  /** @type {Map<string, object>} */
  const leftById = new Map()
  /** @type {Map<string, object>} */
  const rightById = new Map()
  for (const todo of Array.isArray(left?.todos) ? left.todos : []) {
    if (todo === null || typeof todo !== 'object' || typeof todo.id !== 'string') continue
    leftById.set(todo.id, todo)
  }
  for (const todo of Array.isArray(right?.todos) ? right.todos : []) {
    if (todo === null || typeof todo !== 'object' || typeof todo.id !== 'string') continue
    rightById.set(todo.id, todo)
  }
  let added = 0
  let updated = 0
  let localWins = 0
  for (const [id, todo] of leftById) {
    chosen.set(id, todo)
    const other = rightById.get(id)
    if (other === undefined) continue
    if (newer(todo, other) === other) {
      chosen.set(id, other)
      // Same content on both sides is not a change, even when the ids match.
      if (canonical(todo) !== canonical(other)) updated += 1
    } else {
      localWins += 1
    }
  }
  for (const [id, todo] of rightById) {
    if (leftById.has(id)) continue
    chosen.set(id, todo)
    added += 1
  }

  // Tombstones outlive the record they describe, so the union is taken first and applied
  // to the fold: a record is gone when somebody deleted it at or after its last edit.
  /** @type {Map<string, object>} */
  const graves = new Map()
  for (const source of [left?.trash, right?.trash]) {
    if (!Array.isArray(source)) continue
    for (const entry of normalizeTrash(source, { limit })) {
      const previous = graves.get(entry.id)
      if (previous === undefined || entry.at > previous.at) graves.set(entry.id, entry)
    }
  }
  const todos = []
  let removed = 0
  for (const todo of chosen.values()) {
    const grave = graves.get(todo.id)
    if (grave !== undefined && grave.at >= (Number(todo.updatedAt) || 0)) {
      removed += 1
      continue
    }
    todos.push(todo)
  }

  // Deterministic order: the fold must not depend on which side was read first.
  todos.sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id))
  // Count the numbering collisions before `assignSequence` repairs them, so the sync report
  // can say that two machines had handed out the same number.
  const seenSeq = new Set()
  let duplicates = 0
  for (const todo of todos) {
    if (seenSeq.has(todo.seq)) duplicates += 1
    else seenSeq.add(todo.seq)
  }
  const numbered = assignSequence(todos)

  const cutoff = now - ttl
  const trash = [...graves.values()]
    .filter((entry) => entry.at >= cutoff)
    .sort((first, second) => second.at - first.at || first.id.localeCompare(second.id))
    .slice(0, limit)

  return {
    version: SCHEMA_VERSION,
    todos: numbered,
    trash,
    stats: { total: numbered.length, added, updated, removed, localWins, duplicates },
  }
}
