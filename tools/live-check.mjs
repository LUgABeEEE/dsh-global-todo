/**
 * Live verification against a running Host.
 *
 * `npm test` proves the code paths with doubles; this proves the *wired* Host:
 * the routes the panel really calls, the list the panel really reads, and the
 * record that survives a delete-and-undo. It needs a reachable Host, so it is
 * deliberately not part of `npm run verify`.
 *
 *   node tools/live-check.mjs [--base http://127.0.0.1:3080/api/global-todo]
 *
 * Everything it creates is removed again, including on failure.
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'

const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const BASE = baseIndex >= 0 && args[baseIndex + 1] !== undefined ? args[baseIndex + 1] : 'http://127.0.0.1:3080/api/global-todo'

/** @type {string[]} */
const failures = []
/** @type {string[]} */
const notes = []

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
  if (condition === true) console.log(`  ok   ${message}`)
  else {
    console.log(`  FAIL ${message}`)
    failures.push(message)
  }
}

/**
 * @param {string} path
 * @param {object | undefined} body
 * @param {string} [method]
 * @returns {Promise<{ status: number, payload: any }>}
 */
async function call(path, body, method = 'POST') {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, payload: await response.json() }
}

/** The record this script owns, so a failure still cleans up. */
let temporaryId = ''

async function main() {
  console.log(`live check against ${BASE}`)

  console.log('\n[1] health: the surfaces the panel depends on')
  const health = await call('/health', undefined, 'GET')
  const data = health.payload?.data ?? {}
  check(health.status === 200 && health.payload.ok === true, 'health answers')
  check(Array.isArray(data.tools?.registered) && data.tools.registered.length > 0, `the agent tools are registered (${data.tools?.registered?.length ?? 0})`)
  check(data.tools?.error === null || data.tools?.error === undefined, 'no tool registration error')
  check(data.dispatch?.agents === true, 'the dispatch surface found the agents service')
  notes.push(`version ${data.version} · completion.watching=${data.completion?.watching} · target.trackingRecent=${data.target?.trackingRecent}`)

  console.log('\n[2] delete → undo: the record must come back identical')
  const created = await call('/create', {
    title: `[live-check] undo round trip ${new Date().toISOString()}`,
    description: 'created by tools/live-check.mjs; removed again before this script exits',
    links: [
      { kind: 'url', value: 'https://example.com/live-check', title: 'example' },
      // fileURLToPath, not URL.pathname: a repository path with non-ASCII
      // characters would otherwise be percent-encoded and fail the Host's
      // existence check.
      { kind: 'file', value: path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'README.zh.md'), title: 'README.zh.md' },
    ],
    tags: ['live-check'],
    priority: 'urgent',
    dueAt: '2026-12-31T10:00',
  })
  const original = created.payload?.data?.todo
  check(
    created.payload?.ok === true && typeof original?.id === 'string',
    `a temporary todo was created${created.payload?.ok === true ? '' : ` — ${created.payload?.error ?? 'no reason given'}`}`,
  )
  if (original === undefined) return
  temporaryId = original.id

  const removed = await call('/remove', { id: original.id })
  check(removed.payload?.ok === true, 'it was removed')
  const gone = await call(`/get?id=${original.id}`, undefined, 'GET')
  check(gone.status === 404, 'a removed todo is gone from /get (404)')

  const restored = await call('/restore', { todo: original })
  const back = restored.payload?.data?.todo
  check(restored.payload?.ok === true, 'it was restored')
  for (const field of ['id', 'createdAt', 'dueAt', 'priority', 'description']) {
    check(back?.[field] === original[field], `restored ${field} is identical`)
  }
  check(JSON.stringify(back?.links) === JSON.stringify(original.links), 'restored attachments are identical')
  check(JSON.stringify(back?.tags) === JSON.stringify(original.tags), 'restored tags are identical')

  console.log('\n[3] the list the panel renders: session state per row')
  const list = await call('/list?status=all', undefined, 'GET')
  const todos = list.payload?.data?.todos ?? []
  check(Array.isArray(todos) && todos.length > 0, `the list answers (${todos.length} records)`)
  check(typeof list.payload?.data?.counts?.total === 'number', 'the list carries counts')
  const bound = todos.filter((todo) => (todo.sessionId ?? '') !== '')
  check(bound.length > 0, `some records are bound to a conversation (${bound.length})`)
  for (const todo of bound) {
    check(typeof todo.sessionAlive === 'boolean', `${todo.id} reports a boolean sessionAlive`)
    check(typeof todo.sessionDir === 'string', `${todo.id} reports sessionDir`)
  }
  const alive = bound.filter((todo) => todo.sessionAlive === true)
  notes.push(`${bound.length} bound record(s), ${alive.length} with a live conversation`)

  console.log('\n[4] every record the panel would render is well formed')
  for (const todo of todos) {
    const shaped =
      typeof todo.id === 'string' &&
      typeof todo.title === 'string' &&
      Array.isArray(todo.links) &&
      Array.isArray(todo.tags) &&
      typeof todo.createdAt === 'number' &&
      ['open', 'doing', 'done', 'cancelled'].includes(todo.status)
    check(shaped, `${todo.id} has the fields the panel reads`)
  }
}

try {
  await main()
} catch (error) {
  console.error(`\nlive check could not finish: ${error?.message ?? error}`)
  failures.push('the check itself threw')
} finally {
  if (temporaryId !== '') {
    const cleaned = await call('/remove', { id: temporaryId }).catch(() => undefined)
    console.log(`\ncleanup: temporary record ${temporaryId} ${cleaned?.payload?.ok === true ? 'removed' : 'NOT removed — remove it by hand'}`)
  }
  for (const note of notes) console.log(`note: ${note}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nlive check: ok')
  process.exit(0)
}
