/**
 * Small, shared file-system guarantees.
 *
 * Both the todo file and the diagnostics log are replaced by "write a sibling, then
 * rename". That pattern has two platform traps this module exists to absorb:
 *
 * 1. `fsync` on Windows is `FlushFileBuffers`, which needs a **writable** handle. A
 *    read-only handle always throws `EPERM`, and a save that throws before its rename
 *    is a save that never happened (issue #2).
 * 2. Antivirus, the search indexer and a concurrent reader can hold a handle for a few
 *    milliseconds, which makes the rename fail with `EPERM`/`EBUSY`/`EACCES`. Retrying
 *    those turns a spurious failure into a write; other errors still surface at once.
 *
 * @module dsh-global-todo/atomic
 */

import { open, rename, unlink } from 'node:fs/promises'

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Rename, retrying only the errors that mean "someone else has it for a moment".
 *
 * @param {{ rename: (from: string, to: string) => Promise<void> }} io
 * @param {string} from temporary file
 * @param {string} to target file
 */
export async function renameWithRetry(io, from, to, attempts = 4) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(from, to)
      return
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

/**
 * Replace a file atomically, and survive a platform that refuses `fsync`.
 *
 * The handle is opened for **writing** on purpose: on Windows `handle.sync()` needs a
 * writable handle, and opening the temp file read-only made every write throw before the
 * rename (the todo list looked empty while `*.tmp` debris accumulated).
 *
 * The sync itself is best effort: durability matters, but losing a save because a
 * platform will not flush a handle is worse than a save that reaches the page cache.
 *
 * @param {string} file absolute path of the target
 * @param {string} payload bytes to write
 * @param {{ fs?: object, onSyncError?: (error: unknown) => void, renameAttempts?: number }} [options]
 *   injected for tests; `renameAttempts` is there for callers whose target is read constantly
 */
export async function atomicWrite(file, payload, options = {}) {
  const io = options.fs ?? { open, rename, unlink }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  let handle = null
  let renamed = false
  try {
    handle = await io.open(temp, 'w', 0o600)
    await handle.writeFile(payload, 'utf8')
    try {
      await handle.sync()
    } catch (error) {
      options.onSyncError?.(error)
    }
    await handle.close()
    handle = null
    await renameWithRetry(io, temp, file, options.renameAttempts)
    renamed = true
  } finally {
    if (handle !== null) await handle.close().catch(() => {})
    // Only debris is cleaned up: after a successful rename the temp file is gone.
    if (!renamed) await io.unlink(temp).catch(() => {})
  }
}
