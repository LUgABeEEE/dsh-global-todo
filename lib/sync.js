/**
 * Copying the list to the other machines.
 *
 * The store is one file per machine, and the reason it is a file (readable, diffable,
 * no service to be absent) is also the reason two machines cannot share it directly: a
 * network path makes every read a network round trip, and a machine that is offline cannot
 * open its own list at all.
 *
 * So each machine keeps its own file and they meet at a **hub document** in a directory both
 * can reach — a NAS share, a synced folder, a git working tree. A sync is: fold the hub into
 * the local list, fold the local list back into the hub, write both. The fold is commutative
 * and idempotent (lib/replica.js), so order, a retry, or two machines running at once cannot
 * lose a record.
 *
 * Three deliberate choices:
 *
 *  - **The hub is never read on the request path.** Reading the list from a NAS would make
 *    the panel wait on a network mount, and a stale mount would hang every page load. A
 *    sync runs on a timer and on demand; the local file stays the thing that answers.
 *  - **Nothing here is fatal.** A sync that fails reports a typed code and leaves the local
 *    list untouched — the machine stays usable, and the next tick tries again.
 *  - **The hub write is locked and re-merged.** Two machines syncing in the same second would
 *    otherwise each write a document computed from the copy they read, and the slower rename
 *    would erase the other's arrivals.
 *
 * The directory comes from a getter rather than a captured value: the panel can change it
 * while the Host runs, and a captured path would keep syncing to yesterday's share. The same
 * getter shape serves the plugin config (headless deployments) and `settings.json` (the panel).
 *
 * @module dsh-global-todo/sync
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { atomicWrite } from './atomic.js'
import { TodoError } from './errors.js'
import { createFileLock } from './lockfile.js'
import { normalizeStored } from './model.js'
import { mergeDocuments, normalizeTrash } from './replica.js'
import { normalizeSyncDir } from './settings.js'

/** The file two machines meet in. One per directory, so two profiles can share one share. */
export const HUB_FILE = 'todos.hub.json'

/**
 * How long one filesystem call may take before the sync gives up on it.
 *
 * A cifs mount that has gone stale answers nothing at all — it does not fail, it waits — and
 * without a bound the timer would sit inside one call forever. The operation itself cannot be
 * cancelled; the point is that the sync reports a failure and the next tick starts a new one.
 */
export const HUB_TIMEOUT_MS = 20_000

const DEFAULT_MINUTES = 5

/**
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms, what) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TodoError('sync-timeout', `${what}超过 ${Math.round(ms / 1000)} 秒没有回应`)),
      ms,
    )
    timer.unref?.()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * @param {object} options
 * @param {object} options.store - the local store
 * @param {{ dir?: string, intervalMinutes?: number }} [options.config] - deployment default
 * @param {() => unknown} [options.getDir] - the current directory, when a setting can change
 * @param {() => unknown} [options.getInterval] - the current interval in minutes
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 */
export function createSync(options) {
  const store = options.store
  const config = options.config ?? {}
  const logger = options.logger
  const now = options.now ?? (() => Date.now())

  /** The directory in force right now: the setting when it is set, otherwise the deployment key. */
  const dirOf = () => normalizeSyncDir(typeof options.getDir === 'function' ? options.getDir() : config.dir)

  /** Minutes between folds; 0 means "only when asked". */
  const minutesOf = () => {
    const raw = typeof options.getInterval === 'function' ? options.getInterval() : config.intervalMinutes
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_MINUTES
  }

  /** Hub path and its lock, rebuilt when the directory changes. */
  let head = { dir: '', hubFile: '', lock: null }
  const target = () => {
    const dir = dirOf()
    if (dir === '') return { dir: '', hubFile: '', lock: null }
    if (head.dir === dir) return head
    const hubFile = path.join(dir, HUB_FILE)
    head = {
      dir,
      hubFile,
      lock: createFileLock({
        file: `${hubFile}.lock`,
        // Longer than a local lock: the hub is a network file, and a whole write can take a
        // second or two on a busy share.
        timeoutMs: 15_000,
        staleMs: 30_000,
        logger,
      }),
    }
    return head
  }

  /** @type {{ at: number, ok: boolean, stats: object | null, error: string | null, durationMs: number } | null} */
  let last = null
  let running = false
  let error = null

  /**
   * Read the hub. A missing hub is an empty document — the first machine to sync creates it;
   * an unreadable one is a failure, because guessing would overwrite it.
   *
   * @param {string} hubFile
   * @returns {Promise<{ exists: boolean, doc: { version: number, todos: object[], trash: object[] } }>}
   */
  async function readHub(hubFile) {
    let text
    try {
      text = await withTimeout(readFile(hubFile, 'utf8'), HUB_TIMEOUT_MS, '读取共享待办')
    } catch (failure) {
      if (failure?.code === 'ENOENT') return { exists: false, doc: { version: 2, todos: [], trash: [] } }
      if (failure instanceof TodoError) throw failure
      throw new TodoError('sync-unavailable', `读不到共享文件 ${hubFile}：${failure?.message ?? failure}`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (failure) {
      throw new TodoError('sync-corrupt', `共享文件 ${hubFile} 不是合法 JSON：${failure?.message ?? failure}`)
    }
    const raw = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.todos) ? parsed.todos : null
    if (raw === null) throw new TodoError('sync-corrupt', `共享文件 ${hubFile} 里没有 todos 数组`)
    // The hub is written by another machine, which may be older or buggier than this one:
    // every record goes through the same repair a stored record does. A record that cannot be
    // read is skipped, never fatal — one bad entry must not stop the sync forever.
    const todos = []
    const seen = new Set()
    for (const entry of raw) {
      const todo = normalizeStored(entry, {})
      if (todo === null || seen.has(todo.id)) continue
      seen.add(todo.id)
      todos.push(todo)
    }
    return { exists: true, doc: { version: 2, todos, trash: normalizeTrash(parsed.trash) } }
  }

  /**
   * @param {string} hubFile
   * @param {{ version: number, todos: object[], trash: object[] }} doc
   */
  async function writeHub(hubFile, doc) {
    const payload = `${JSON.stringify({ version: doc.version, todos: doc.todos, trash: doc.trash }, null, 2)}\n`
    await withTimeout(
      atomicWrite(hubFile, payload, {
        onSyncError: (failure) =>
          logger?.warn?.(
            `dsh-global-todo: 共享文件落盘后 fsync 失败（已继续）${hubFile}：${failure?.message ?? failure}`,
          ),
      }),
      HUB_TIMEOUT_MS,
      '写入共享待办',
    )
  }

  /** Both halves of a document, for a cheap "did anything change" comparison. */
  function same(left, right) {
    return (
      JSON.stringify({ todos: left.todos, trash: left.trash }) ===
      JSON.stringify({ todos: right.todos, trash: right.trash })
    )
  }

  /**
   * The directory has to exist before the lock file beside the hub can be created.
   *
   * The **parent** is what gets checked first, deliberately: `mkdir -p` on an unmounted mount
   * point would create an empty local directory that looks like a working share, and both
   * machines would then sync nothing while reporting success.
   *
   * @param {string} dir
   */
  async function ensureHubDirectory(dir) {
    try {
      await withTimeout(stat(path.dirname(dir)), HUB_TIMEOUT_MS, '检查共享目录')
    } catch (failure) {
      throw new TodoError(
        'sync-unavailable',
        `共享目录的上层不存在（共享盘没挂上？）${path.dirname(dir)}：${failure?.message ?? failure}`,
      )
    }
    try {
      await withTimeout(mkdir(dir, { recursive: true }), HUB_TIMEOUT_MS, '创建共享目录')
    } catch (failure) {
      throw new TodoError('sync-unavailable', `建不了共享目录 ${dir}：${failure?.message ?? failure}`)
    }
  }

  /**
   * Run one sync.
   *
   * @param {{ dryRun?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, at: number, dir: string, hubFile: string, stats: object, hubCreated: boolean, wrote: { hub: boolean, local: boolean } }>}
   */
  async function run(options = {}) {
    const { dir, hubFile, lock } = target()
    if (dir === '') throw new TodoError('sync-not-configured', '没有配置共享目录：在面板设置里填「多端同步」的目录')
    if (running) throw new TodoError('sync-busy', '上一次同步还没有结束')
    running = true
    const startedAt = now()
    try {
      const local = await store.read()
      // Checked before anything is read from the share: see ensureHubDirectory.
      await ensureHubDirectory(dir)
      const hub = await readHub(hubFile)

      // The hub gets everything this machine has; the local list gets everything the hub has.
      const outbound = mergeDocuments(hub.doc, local, { now: now() })
      const hubChanged = !same(hub.doc, outbound)

      let wroteHub = false
      /** The hub as it is now — fuller than the copy read above once a concurrent writer is folded in. */
      let hubDoc = null
      if (!options.dryRun && (hubChanged || !hub.exists)) {
        await lock.acquire()
        try {
          // Re-read under the lock: another machine may have written while this one was
          // folding, and its arrivals must survive this write.
          const fresh = await readHub(hubFile)
          const folded = mergeDocuments(fresh.doc, outbound, { now: now() })
          if (!same(fresh.doc, folded) || !fresh.exists) {
            await writeHub(hubFile, folded)
            wroteHub = true
          }
          hubDoc = folded
        } finally {
          await lock.release()
        }
      }

      const inbound = mergeDocuments(local, hubDoc ?? outbound, { now: now() })
      const localChanged = !same(local, inbound)
      const result = {
        ok: true,
        at: now(),
        dir,
        hubFile,
        hubCreated: !hub.exists,
        wrote: { hub: wroteHub, local: false },
        stats: {
          total: inbound.todos.length,
          // From this machine's point of view: what it contributed, what it received.
          sent: outbound.stats.added + outbound.stats.updated,
          received: inbound.stats.added + inbound.stats.updated,
          removed: inbound.stats.removed,
          renumbered: inbound.stats.duplicates,
        },
      }
      if (!options.dryRun && localChanged) {
        const applied = await store.update((current) => {
          // Fold against the list as it is now, not as it was when this run started: the panel
          // may have written while the share was answering.
          const folded = mergeDocuments(current, inbound, { now: now() })
          current.trash = folded.trash
          return { next: folded.todos, result: folded.stats }
        })
        result.wrote.local = true
        result.stats.total = applied.total
        result.stats.removed = applied.removed
      }
      last = { at: result.at, ok: true, stats: result.stats, error: null, durationMs: now() - startedAt }
      error = null
      logger?.debug?.(
        `dsh-global-todo: 同步完成 ${dir} 共 ${result.stats.total} 条，送出 ${result.stats.sent}，收到 ${result.stats.received}`,
      )
      return result
    } catch (failure) {
      const message = String(failure?.message ?? failure)
      error = message
      last = { at: now(), ok: false, stats: null, error: message, durationMs: now() - startedAt }
      logger?.warn?.(`dsh-global-todo: 同步失败：${message}`)
      if (failure instanceof TodoError) throw failure
      throw new TodoError('sync-failed', message)
    } finally {
      running = false
    }
  }

  /** @returns {Record<string, unknown>} what the panel and /health report */
  function describe() {
    const { dir, hubFile } = target()
    return {
      configured: dir !== '',
      dir,
      hubFile,
      intervalMinutes: minutesOf(),
      running,
      last,
      error,
    }
  }

  return { run, describe, dirOf, minutesOf }
}
