/**
 * Capture quality gate.
 *
 * `global_todo_capture` is the one path that can add several records at once, and a capture run
 * that keeps re-registering what the list already has is how the list turns into noise. The
 * first version compared normalised titles exactly against the active rows; that misses the
 * common case — same errand, different wording — and it re-admits something that was finished
 * yesterday. Both are pure decisions, so they live here and are tested without a store.
 *
 * @module dsh-global-todo/capture
 */

/** Titles closer than this are treated as the same errand. */
const SIMILARITY = 0.8
/** Only compare against rows from the last few days; older ones are history, not duplicates. */
const DEDUPE_WINDOW_HOURS = 72
/** A finished errand stays done this long before the same title may come back. */
const DONE_COOLDOWN_DAYS = 7

/**
 * Fold a title to what it means: width, case, spacing and punctuation are noise.
 *
 * Numbers and dates are kept on purpose — "10 月 20 日交" and "10 月 21 日交" are different
 * errands even though they differ by one character.
 *
 * @param {unknown} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** @param {string} text @returns {Set<string>} */
function bigrams(text) {
  const chars = [...text]
  if (chars.length < 2) return new Set(chars)
  const out = new Set()
  for (let index = 0; index < chars.length - 1; index += 1) out.add(chars[index] + chars[index + 1])
  return out
}

/**
 * Dice coefficient over character bigrams: 0 when unrelated, 1 when identical.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
export function similarity(left, right) {
  const a = bigrams(normalizeTitle(left))
  const b = bigrams(normalizeTitle(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * Is this title already on the list, in a way a person would call a duplicate?
 *
 * @param {{ title?: unknown, existing?: object[], now?: number, similarity?: number, windowHours?: number, doneCooldownDays?: number }} input
 * @returns {{ duplicate: boolean, reason?: string, matchId?: string }}
 */
export function findDuplicate(input) {
  const title = input.title
  const key = normalizeTitle(title)
  if (key === '') return { duplicate: false }
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const windowMs = (input.windowHours ?? DEDUPE_WINDOW_HOURS) * 60 * 60 * 1000
  const cooldownMs = (input.doneCooldownDays ?? DONE_COOLDOWN_DAYS) * 24 * 60 * 60 * 1000
  const threshold = Number.isFinite(input.similarity) ? input.similarity : SIMILARITY
  for (const todo of Array.isArray(input.existing) ? input.existing : []) {
    if (todo === null || typeof todo !== 'object' || typeof todo.title !== 'string') continue
    // Archived is history a person chose to keep out of the way; it must not block the same
    // errand from being written again. Cancelled is likewise not a live duplicate.
    if (todo.status === 'cancelled' || todo.status === 'archived') continue
    const doneAt = Number.isFinite(todo.doneAt)
      ? todo.doneAt
      : Number.isFinite(todo.updatedAt) ? todo.updatedAt : 0
    if (normalizeTitle(todo.title) === key) {
      if (todo.status === 'done') {
        if (now - doneAt < cooldownMs) return { duplicate: true, reason: 'recently-done', matchId: todo.id }
      } else {
        return { duplicate: true, reason: 'same-active', matchId: todo.id }
      }
    }
    if (todo.status !== 'done') {
      const created = Number.isFinite(todo.createdAt) ? todo.createdAt : now
      // A five-day-old item is not evidence that today's wording is a duplicate; only the
      // recent window is compared for similarity.
      if (now - created < windowMs && similarity(title, todo.title) >= threshold) {
        return { duplicate: true, reason: 'similar-active', matchId: todo.id }
      }
    }
  }
  return { duplicate: false }
}

/** The sentence a person reads in `skipped[].error`. */
export const CAPTURE_REASONS = Object.freeze({
  'same-active': '清单里已有同名的未完成条目，未重复登记',
  'similar-active': '清单里已有一条很相似的未完成条目，未重复登记',
  'recently-done': '这条刚完成不久（7 天内），没有重复登记',
})
