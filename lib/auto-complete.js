/**
 * Ticking off what a conversation finished.
 *
 * The guidance asks an agent to mark its own work done, and it usually does — "usually" is
 * not a list. So when a conversation that *wrote* todos goes quiet (nothing said for the
 * idle window) after a clean turn, the Host closes the ones it owns, with a summary that
 * says exactly why. It is reversible (`global_todo_update` reopens), and it does not touch
 * todos owned by other conversations.
 *
 * @module dsh-global-todo/auto-complete
 */

/** Statuses that count as "still on the list". */
const OPEN_STATUSES = Object.freeze(['open', 'doing'])

/**
 * The todos a conversation still owes.
 *
 * @param {{ id: string, status: string, originSessionId?: string }[]} todos
 * @param {string} sessionId
 * @returns {object[]}
 */
export function ownedOpenTodos(todos, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return []
  return (Array.isArray(todos) ? todos : []).filter(
    (todo) =>
      todo !== null &&
      typeof todo === 'object' &&
      OPEN_STATUSES.includes(todo.status) &&
      todo.originSessionId === sessionId,
  )
}

/**
 * Close every open todo this conversation wrote.
 *
 * @param {object} input
 * @param {{ list: Function, complete: Function }} input.service
 * @param {string} input.sessionId
 * @param {string} input.summary
 * @param {object} [input.logger]
 * @returns {Promise<string[]>} the ids that were completed
 */
export async function completeOwnedTodos(input) {
  let todos = []
  try {
    todos = (await input.service.list({ status: 'active' })).todos
  } catch (error) {
    input.logger?.warn?.(`dsh-global-todo: 自动划掉前读清单失败（${String(error?.message ?? error)}）`)
    return []
  }
  const owned = ownedOpenTodos(todos, input.sessionId)
  const completed = []
  for (const todo of owned) {
    try {
      await input.service.complete(todo.id, { summary: input.summary }, { by: 'agent' })
      completed.push(todo.id)
    } catch (error) {
      input.logger?.warn?.(`dsh-global-todo: 自动划掉 ${todo.id} 失败（${String(error?.message ?? error)}）`)
    }
  }
  return completed
}
