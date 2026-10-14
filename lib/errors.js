/**
 * Typed, transport-agnostic failures.
 *
 * Every rejection the plugin can produce carries a stable machine code so the
 * HTTP layer, the Agent tools and the browser panel can all report the same
 * reason instead of guessing from an error message. `code` is part of the
 * public contract; `message` is for humans.
 *
 * @module dsh-global-todo/errors
 */

/** Machine codes this plugin may return. Kept in one place on purpose. */
export const ERROR_CODES = Object.freeze([
  'invalid-title',
  'invalid-description',
  'invalid-status',
  'invalid-priority',
  'invalid-due',
  'invalid-tags',
  'invalid-link',
  'invalid-body',
  'invalid-json',
  'payload-too-large',
  'not-found',
  'store-corrupt',
  'store-unwritable',
  'agents-unavailable',
  'dispatch-failed',
  'forbidden',
  'internal',
])

/** A failure that is safe to hand back to a caller. */
export class TodoError extends Error {
  /**
   * @param {string} code - one of {@link ERROR_CODES}
   * @param {string} message - human-readable explanation
   * @param {Record<string, unknown>} [details] - extra structured context
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'TodoError'
    this.code = code
    if (details !== undefined) this.details = details
  }

  /** Wire shape shared by REST replies and tool results. */
  toJSON() {
    return {
      ok: false,
      reason: this.code,
      error: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/** @returns {boolean} whether `error` is one of ours */
export function isTodoError(error) {
  return error instanceof TodoError
}

/**
 * Wrap an unknown throwable as a {@link TodoError} without losing the original.
 *
 * @param {unknown} error
 * @param {string} [code]
 * @returns {TodoError}
 */
export function asTodoError(error, code = 'internal') {
  if (isTodoError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = new TodoError(code, message)
  if (error instanceof Error) wrapped.cause = error
  return wrapped
}
