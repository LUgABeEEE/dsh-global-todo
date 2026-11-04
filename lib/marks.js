/**
 * The prefixes this plugin writes into a record's notes.
 *
 * One place, because three modules need to agree on them: the triage reads the deferral and the
 * chase, the router writes the daily note and the watchdog's, and the watchdog has to know which
 * notes are *bookkeeping* rather than progress. A literal per module is how a rename becomes
 * "the mark exists but nothing reads it".
 *
 * They are prefixes rather than fields on purpose — a note replicates through the existing sync,
 * is visible in the panel, and needs no migration (see `docs/DESIGN.md`).
 *
 * @module dsh-global-todo/marks
 */

/** Written by `POST /snooze`: 「not today」 until the day in the text. */
export const SNOOZE_MARK = '【推迟'

/** Written by `POST /chase`: 「I nudged the other side」. */
export const CHASE_MARK = '【催办'

/** Written by the daily tick: today's three, and why. */
export const TRIAGE_MARK = '【分诊'

/** Written by the tick when a hand-off went quiet. */
export const WATCHDOG_MARK = '【看门狗'

/**
 * Notes this plugin writes about a record, as opposed to notes that are work on it.
 *
 * The watchdog uses this to answer "did anything happen since the hand-off": its own daily
 * announcement is not an answer to that question, and counting it would hide exactly the stall
 * the watchdog exists to name.
 */
export const BOOKKEEPING_MARKS = Object.freeze([TRIAGE_MARK, WATCHDOG_MARK, SNOOZE_MARK, CHASE_MARK])

/**
 * @param {unknown} text
 * @returns {boolean} whether this note is one of the plugin's own marks
 */
export function isBookkeepingNote(text) {
  if (typeof text !== 'string') return false
  return BOOKKEEPING_MARKS.some((mark) => text.startsWith(mark))
}
