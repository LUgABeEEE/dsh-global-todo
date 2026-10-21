/**
 * Persistence: one JSON file, atomic writes, serialized read-modify-write.
 *
 * Why a file and not a database: the list is a human artifact. It should be
 * readable with `cat`, editable by hand, diffable in git and copyable to a
 * notes repo or a synced folder. A file also keeps this plugin free of any
 * runtime dependency and of any service that may be absent from a given Host
 * composition.
 *
 * Two properties matter more than speed here:
 *
 *  - **Never leave a half-written file.** Writes go to a sibling temp file,
 *    are flushed, and are then `rename()`d over the target — atomic on POSIX
 *    and on Windows for same-directory renames.
 *  - **Never interleave two writers.** The human (HTTP) and the agent (tools)
 *    write the same file; every mutation runs through one promise chain, so a
 *    read-modify-write can never lose the other side's change.
 *
 * @module dsh-global-todo/store
 */

import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { atomicWrite } from './atomic.js'
import { TodoError } from './errors.js'
import { LIMITS, SCHEMA_VERSION, normalizeStored } from './model.js'

// Re-exported because the tests (and anyone poking at the store) reach for it here; the
// implementation lives in atomic.js so the diagnostics log can share it.
export { atomicWrite }

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} the DSH home directory
 */
export function resolveHomeDir(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured === '' ? path.join(homedir(), '.dsh') : configured
}

/**
 * Where the list lives. An explicit `storePath` wins; otherwise
 * `$DSH_HOME/global-todo/todos.json`.
 *
 * @param {{ storePath?: string }} [config]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} absolute path
 */
export function resolveStorePath(config = {}, env = process.env) {
  const configured = typeof config.storePath === 'string' ? config.storePath.trim() : ''
  if (configured !== '') return path.resolve(configured)
  return path.join(resolveHomeDir(env), 'global-todo', 'todos.json')
}

/**
 * @param {unknown} value
 * @returns {{ version: number, todos: object[] }} a salvaged document
 */
function salvage(value, activityLimit) {
  const doc = value !== null && typeof value === 'object' ? value : {}
  const raw = Array.isArray(doc.todos) ? doc.todos : []
  const todos = []
  const seen = new Set()
  for (const entry of raw) {
    const todo = normalizeStored(entry, { activityLimit })
    if (todo === null || seen.has(todo.id)) continue
    seen.add(todo.id)
    todos.push(todo)
  }
  return { version: Number.isInteger(doc.version) ? doc.version : SCHEMA_VERSION, todos: assignSequence(todos) }
}

/**
 * Give every record its human-facing number.
 *
 * Existing numbers are kept so "把 #42 交给 Agent" stays true after other records are
 * deleted; records without one are numbered in creation order, and the next write
 * persists them. A file that never gets written again keeps deriving the same numbers.
 *
 * @param {object[]} todos
 * @returns {object[]}
 */
function assignSequence(todos) {
  let max = 0
  for (const todo of todos) if (Number.isInteger(todo.seq) && todo.seq > max) max = todo.seq
  const missing = todos.filter((todo) => !Number.isInteger(todo.seq) || todo.seq <= 0)
  missing.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  for (const todo of missing) todo.seq = ++max
  return todos
}

/**
 * @param {{ file: string, logger?: object, activityLimit?: number, now?: () => number }} options
 */
export function createStore(options) {
  const file = options.file
  const logger = options.logger
  const activityLimit = options.activityLimit ?? LIMITS.activity
  const now = options.now ?? (() => Date.now())

  /** Serializes every mutation; also lets `update` await the writes before it. */
  let chain = Promise.resolve()

  /**
   * Fingerprint of the file as this process last read or wrote it.
   *
   * The file is meant to be portable — a synced folder, a NAS — so another machine changing it
   * is a normal event, not an error. It must not be silent either: a read that sees a different
   * `mtimeMs:size` than the last one this process established is reported through `describe()`
   * so the panel can say the list changed elsewhere. One increment per external change, not per
   * poll, which is why `known` is updated as the change is noticed.
   */
  let known = null
  let externalChanges = 0
  let lastExternalAt = null

  /** @param {{ mtimeMs: number, size: number } | null} info */
  function remember(info) {
    if (info === null) {
      known = null
      return
    }
    known = `${info.mtimeMs}:${info.size}`
  }

  /** Note a read that disagrees with what this process last saw. */
  function observe(info) {
    if (info === null) {
      if (known !== null) {
        externalChanges += 1
        lastExternalAt = now()
      }
      known = null
      return
    }
    const fingerprint = `${info.mtimeMs}:${info.size}`
    if (known !== null && known !== fingerprint) {
      externalChanges += 1
      lastExternalAt = now()
    }
    known = fingerprint
  }

  /**
   * Read the document. A missing file is an empty list; an unparseable file is
   * an error, never a silent reset — overwriting a mangled-but-recoverable file
   * would destroy the only copy of the user's list.
   *
   * @returns {Promise<{ version: number, todos: object[] }>}
   */
  async function read() {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // The file this process knew about is gone: somebody else removed or moved it.
        observe(null)
        return { version: SCHEMA_VERSION, todos: [] }
      }
      throw new TodoError('store-unwritable', `读不到待办文件 ${file}：${error?.message ?? error}`)
    }
    // Compare before parsing: a corrupt write from elsewhere is still a change worth naming.
    observe(await stat(file).catch(() => null))
    if (text.trim() === '') return { version: SCHEMA_VERSION, todos: [] }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new TodoError('store-corrupt', `${file} 不是合法 JSON：${error?.message ?? error}`, { file })
    }
    const doc = salvage(parsed, activityLimit)
    if (doc.version > SCHEMA_VERSION) {
      throw new TodoError(
        'store-corrupt',
        `${file} 的 schema 版本是 ${doc.version}，本插件只认识 ${SCHEMA_VERSION}；请升级插件，或把文件移走来新建一份`,
        { file, version: doc.version },
      )
    }
    return doc
  }

  /**
   * Atomically replace the file.
   *
   * @param {{ version: number, todos: object[] }} doc
   */
  async function write(doc) {
    const directory = path.dirname(file)
    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      // A file where the directory should be reports ENOTDIR on POSIX and EEXIST on
      // Windows; both mean the same thing to the caller, so both become store-unwritable.
      throw new TodoError('store-unwritable', `建不了待办目录 ${directory}：${error?.message ?? error}`, { file })
    }
    const payload = `${JSON.stringify({ version: SCHEMA_VERSION, todos: doc.todos }, null, 2)}\n`
    try {
      await atomicWrite(file, payload, {
        // A platform that will not flush the temp file is a warning, not a lost save.
        onSyncError: (error) =>
          logger?.warn?.(`dsh-global-todo: 落盘后 fsync 失败（已继续）${file}：${error?.message ?? error}`),
      })
    } catch (error) {
      throw new TodoError('store-unwritable', `写入待办文件失败 ${file}：${error?.message ?? error}`, { file })
    }
    // Best effort: make the rename itself durable. Not every platform allows
    // opening a directory, and failing here must not fail the write.
    try {
      const dir = await open(directory, 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } catch {
      /* ignore */
    }
    // This write is the new baseline, so the next read does not report our own change.
    remember(await stat(file).catch(() => null))
  }

  /**
   * Run one mutation under the write lock.
   *
   * The mutator receives the freshly read document and returns either a
   * replacement document or a result object `{ doc, result }`. It may mutate
   * the document in place; the store only writes when the mutator reports a
   * change.
   *
   * @template T
   * @param {(doc: { version: number, todos: object[] }) => ({ next?: object, result: T } | Promise<{ next?: object, result: T }>)} mutator
   * @returns {Promise<T>}
   */
  function update(mutator) {
    const run = chain.then(async () => {
      const doc = await read()
      const outcome = (await mutator(doc)) ?? {}
      if (outcome.next !== undefined) {
        if (!Array.isArray(outcome.next)) {
          // An internal invariant: a mutator may only hand back a todo array.
          // Catching it here keeps a bug from writing a document that every
          // later read would treat as empty.
          throw new TodoError('internal', 'store.update 的 next 必须是待办数组')
        }
        await write({ version: SCHEMA_VERSION, todos: outcome.next })
      }
      return outcome.result
    })
    // Keep the chain alive after a rejection so one failed write does not wedge
    // every later operation.
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** @returns {Promise<object[]>} a copy of every todo */
  async function all() {
    const doc = await read()
    return doc.todos
  }

  /** @returns {Promise<Record<string, unknown>>} where the data actually is */
  async function describe() {
    let bytes = 0
    let exists = false
    let todos = 0
    try {
      const text = await readFile(file, 'utf8')
      exists = true
      bytes = Buffer.byteLength(text)
      todos = salvage(JSON.parse(text), activityLimit).todos.length
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`dsh-global-todo: 无法统计 ${file}：${error?.message ?? error}`)
      }
    }
    return {
      kind: 'json',
      file,
      exists,
      bytes,
      todos,
      schemaVersion: SCHEMA_VERSION,
      // How many times the file changed under this process (another machine, a sync client).
      // In memory: it describes this process, and a restart is entitled to forget it.
      externalChanges,
      lastExternalAt,
    }
  }

  return { kind: 'json', file, read, write, update, all, describe }
}
