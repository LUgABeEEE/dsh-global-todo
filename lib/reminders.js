/**
 * Due reminders.
 *
 * The list already knows `dueAt`; what it never did was say anything when one passed. The rule
 * is kept pure so the timer can be tested without waiting: a record is due when it is still
 * active, its deadline is in the past, and this exact deadline has not been announced yet.
 * Keying on `id → dueAt` means postponing a reminder makes it due again, while an announced one
 * stays quiet across ticks and restarts (the map lives with the process).
 *
 * @module dsh-global-todo/reminders
 */

/**
 * @param {object[]} todos
 * @param {{ now?: number, reminded?: Record<string, string|null> }} [options]
 * @returns {{ id: string, seq: number, title: string, dueAt: string }[]}
 */
export function dueReminders(todos, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const reminded = options.reminded !== null && typeof options.reminded === 'object' ? options.reminded : {}
  const due = []
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (todo === null || typeof todo !== 'object') continue
    if (todo.status !== 'open' && todo.status !== 'doing') continue
    if (todo.dueAt === null || todo.dueAt === undefined || typeof todo.dueAt !== 'string') continue
    const at = Date.parse(todo.dueAt)
    if (!Number.isFinite(at) || at > now) continue
    if (reminded[todo.id] === todo.dueAt) continue
    due.push({
      id: todo.id,
      seq: Number.isInteger(todo.seq) ? todo.seq : 0,
      title: typeof todo.title === 'string' ? todo.title : '',
      dueAt: todo.dueAt,
    })
  }
  return due
}
