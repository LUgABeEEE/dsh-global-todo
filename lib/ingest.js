/**
 * Ingest quality gate.
 *
 * The external door is the only entrance to the list that a person did not open in a
 * conversation, so it gets checked before it is opened: a named source, a stated confidence,
 * and — below the confidence threshold — the inbox rather than the main list. The rules are
 * pure so they can be tested without a store or a route.
 *
 * @module dsh-global-todo/ingest
 */

import { LIMITS } from './model.js'
import { INGEST_SOURCES } from './settings.js'

/** Tag that marks a record as waiting for a person. */
export const INBOX_TAG = 'inbox'
/** Upper bound on one ingest request; a mail batch is not a migration. */
export const MAX_INGEST_ITEMS = 100

/**
 * Validate one external item and decide where it lands.
 *
 * @param {unknown} raw
 * @param {{ confirmBelow?: number }} [options]
 * @returns {{ item?: object, source?: string, confidence?: number, inbox?: boolean, error?: string }}
 */
export function normalizeIngestItem(raw, options = {}) {
  const confirmBelow = Number.isFinite(options.confirmBelow) ? options.confirmBelow : 0.8
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: '条目必须是对象' }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title === '') return { error: '缺 title' }
  // The model's own limit, not a second opinion: a 500-character title passed here and was
  // then rejected by create(), which aborted the whole batch instead of skipping one row.
  if (title.length > LIMITS.title) return { error: `title 超过 ${LIMITS.title} 字` }
  const source = raw.source !== null && typeof raw.source === 'object' && !Array.isArray(raw.source) ? raw.source : {}
  const kind = typeof source.kind === 'string' ? source.kind.trim().toLowerCase() : ''
  if (!INGEST_SOURCES.includes(kind)) return { error: `source.kind 必须是 ${INGEST_SOURCES.join(' / ')}` }
  const confidence = Number(raw.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { error: 'confidence 必须是 0–1' }
  // High-confidence items join the list; the rest wait. Both keep the provenance tag so a
  // person can still see where a record came from after it is confirmed.
  const inbox = confidence < confirmBelow
  const tags = [INBOX_TAG, `source:${kind}`]
  if (!inbox) tags.shift()
  const item = { title, tags }
  if (typeof raw.description === 'string') item.description = raw.description
  if (raw.dueAt !== undefined) item.dueAt = raw.dueAt
  if (raw.priority !== undefined) item.priority = raw.priority
  if (Array.isArray(raw.links)) item.links = raw.links
  return { item, source: kind, confidence, inbox }
}

/**
 * Does this record still wait for a person?
 *
 * @param {object} todo
 * @returns {boolean}
 */
export function isInbox(todo) {
  if (todo === null || typeof todo !== 'object' || !Array.isArray(todo.tags)) return false
  return todo.tags.some((tag) => String(tag).toLowerCase() === INBOX_TAG)
}

/**
 * Which inbox records are old enough to be archived. The inbox must not become a second
 * list: something nobody confirmed in a week is not a task any more, it is a decision not
 * taken, and it belongs in the archive rather than at the top of the panel.
 *
 * @param {object[]} todos
 * @param {{ now?: number, days?: number }} [options]
 * @returns {object[]}
 */
export function expiredInbox(todos, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : 7
  const cutoff = now - days * 24 * 60 * 60 * 1000
  return (Array.isArray(todos) ? todos : []).filter((todo) =>
    isInbox(todo) &&
      (todo.status === 'open' || todo.status === 'doing') &&
      Number.isFinite(todo.createdAt) &&
      todo.createdAt < cutoff,
  )
}
