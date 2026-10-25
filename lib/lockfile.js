/**
 * One file on disk, used as a lock between processes.
 *
 * Why this exists: \`store.update\` serializes writers **inside** one process, which is not the
 * same as serializing them. Two DSH processes — the Web host plus a desktop or CLI session, or
 * two machines sharing a synced folder or a NAS — could each read the list, and whichever wrote
 * second silently erased the other's change. The symptom is nasty because both writes succeed.
 *
 * \`open(path, 'wx')\` is the portable test-and-set: it fails with \`EEXIST\` if the file is there,
 * and creating it is atomic on POSIX and on NTFS. No dependency, no \`flock\` (not in Node), and no
 * open handle — a held handle would make the file undeletable on Windows, which is exactly the
 * kind of platform detail this plugin has been bitten by before.
 *
 * The lock file is a claim, not a truth. It carries \`pid\`, \`host\` and a random \`token\`:
 *
 *  - \`pid\` + \`host\` let a waiter ask "can this holder still be writing?", which matters because a
 *    crashed process leaves the file behind forever;
 *  - \`token\` keeps a lock that was declared abandoned and retaken from being deleted by its
 *    previous owner when it finally wakes up.
 *
 * The takeover rule is deliberately conservative: on the same host a lock is only abandoned when
 * the holder is not alive, because a pid says more than a clock. Across hosts there is no pid to
 * ask, so age is all there is — a note for anyone putting this file on a NAS: keep the clocks
 * close, or accept that a really slow writer can be declared dead.
 *
 * @module dsh-global-todo/lockfile
 */

import { open, readFile, stat, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

import { TodoError } from './errors.js'

/** How long a mutation waits for another process before reporting \`store-busy\`. */
export const LOCK_TIMEOUT_MS = 5000

/**
 * How old a lock must be before a **remote** holder is presumed gone. Same-host holders are judged
 * by their pid instead, so this only decides the case with no pid to ask.
 */
export const LOCK_STALE_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means "it exists, but not yours" — alive for our purposes.
    return error?.code === 'EPERM'
  }
}

/**
 * @param {{ file: string, timeoutMs?: number, staleMs?: number, logger?: object, now?: () => number, host?: string, pid?: number }} options
 */
export function createFileLock(options) {
  const file = options.file
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LOCK_TIMEOUT_MS
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : LOCK_STALE_MS
  const logger = options.logger
  const now = options.now ?? (() => Date.now())
  const host = options.host ?? hostname()
  const pid = options.pid ?? process.pid

  /** Token of the lock this instance is holding, or null. */
  let held = null

  /** @returns {Promise<object | null>} the holder's claim, or null when it is gone/unreadable */
  async function readHolder() {
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** Create the lock file exclusively. Throws EEXIST when somebody else got there first. */
  async function take() {
    const token = randomBytes(8).toString('hex')
    const handle = await open(file, 'wx')
    try {
      await handle.writeFile(JSON.stringify({ pid, host, at: now(), token }) + '\n')
      // Best effort: durable enough that a crashed writer is visible after a reboot. A platform
      // that refuses to flush is not a reason to refuse the mutation.
      await handle.sync().catch(() => {})
    } finally {
      await handle.close().catch(() => {})
    }
    held = token
  }

  /**
   * Remove a lock nobody is holding any more.
   *
   * @returns {Promise<boolean>} whether the lock was reaped (the caller may retry immediately)
   */
  async function reapIfAbandoned() {
    let info
    try {
      info = await stat(file)
    } catch (error) {
      if (error?.code === 'ENOENT') return true // released while we were deciding
      return false
    }
    const age = now() - info.mtimeMs
    const holder = await readHolder()
    // On this host a pid settles it, in both directions: a live holder is alive however old the
    // file looks, and a dead one is gone however fresh it looks. Waiting for `staleMs` here would
    // be actively wrong — the reap would land 30 s after the waiter gave up at 5 s.
    const local = holder !== null && holder.host === host && Number.isInteger(holder.pid)
    if (local) {
      if (isAlive(holder.pid)) return false
    } else if (age < staleMs) {
      // No pid to ask (another machine, or a corrupt claim), so age is all there is.
      return false
    }
    try {
      await unlink(file)
    } catch {
      return false
    }
    const who = holder === null ? '无法读取' : (holder.host + ' pid ' + holder.pid)
    logger?.warn?.('dsh-global-todo: 清掉一个过期的写锁 ' + file + '（' + Math.round(age / 1000) + ' 秒没人释放；持有者 ' + who + '）')
    return true
  }

  /** Wait for the lock; throws store-busy when the wait budget runs out. */
  async function acquire() {
    const deadline = now() + timeoutMs
    let delay = 8
    for (;;) {
      try {
        await take()
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new TodoError('store-unwritable', '建不了写锁 ' + file + '：' + (error?.message ?? error), { file })
        }
      }
      if (await reapIfAbandoned()) continue
      if (now() >= deadline) {
        const holder = await readHolder()
        const who = holder === null ? '' : ('（' + (holder.host ?? '?') + ' pid ' + (holder.pid ?? '?') + '）')
        throw new TodoError(
          'store-busy',
          '清单正被另一个进程写入' + who + '，等了 ' + Math.round(timeoutMs / 1000) + ' 秒仍没轮到。请稍后再试；如果一直这样，确认没有第二个宿主进程或另一台机器在用同一份列表。',
          { file },
        )
      }
      // Jitter, so two waiters do not wake on the same tick forever.
      await sleep(delay * (0.5 + Math.random()))
      delay = Math.min(delay * 2, 200)
    }
  }

  /** Release the lock — only if it is still the one this instance took. */
  async function release() {
    const mine = held
    if (mine === null) return
    held = null
    const holder = await readHolder()
    // A reaped-and-retaken lock belongs to somebody else now; deleting it would hand the file to
    // two writers at once.
    if (holder !== null && holder.token !== mine) return
    // Windows can refuse the delete while a virus scanner still holds the handle. Retrying matters
    // more than it looks: this lock records a live pid, so the reaper will never take it, and every
    // later write would sit out its whole timeout instead.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await unlink(file)
        return
      } catch (error) {
        if (error?.code === 'ENOENT') return
        if (attempt === 3) {
          logger?.warn?.(
            `dsh-global-todo: 写锁没删掉 ${file}，后面的写入会等到超时：${error?.message ?? error}`,
          )
          return
        }
        await sleep(15 + attempt * 25)
      }
    }
  }

  return { file, acquire, release }
}
