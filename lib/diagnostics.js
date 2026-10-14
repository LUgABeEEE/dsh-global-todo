/**
 * A tiny inbox for the browser panel's failures.
 *
 * Every failure this plugin has had ended the same way: something went wrong in
 * someone else's browser, the Host looked healthy, and the only copy of the error was
 * in a console nobody was reading. This records what the panel reports, in memory for
 * `/health` and on disk so a restart does not erase the evidence.
 *
 * @module dsh-global-todo/diagnostics
 */

import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises'

/** How many entries `/health` shows, how many are kept in memory, how many on disk. */
const RECENT = 5
const MEMORY = 40
const ON_DISK = 50
const MAX_FIELD = 400

/**
 * @param {{ file: string, logger?: object, now?: () => number }} options
 */
export function createDiagnostics(options) {
  const now = options.now ?? (() => Date.now())
  let entries = []
  let loaded = false
  // Append-and-trim read the whole file, so two of them interleaving can lose a report
  // or leave the file ending mid-history. One chain, one writer.
  let writes = Promise.resolve()
  let rewrites = 0

  const trim = (value) =>
    typeof value === 'string' ? value.slice(0, MAX_FIELD) : value === undefined || value === null ? '' : String(value).slice(0, MAX_FIELD)

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const text = await readFile(options.file, 'utf8')
      entries = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-MEMORY)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((entry) => entry !== null && typeof entry === 'object')
    } catch {
      /* absent is the normal case */
    }
  }

  /**
   * Replace the log with `lines`, through a sibling file and a rename.
   *
   * `writeFile` truncates its target before it writes, so a reader that lands in that
   * window sees an empty log. That is not hypothetical: a CI reader doing exactly this
   * got `''` where it expected the newest report, which is what a bounded-trail
   * assertion is supposed to be reading. A rename is atomic, so a reader sees either
   * the old file or the new one, never a hole in between.
   *
   * @param {string[]} lines
   */
  const rewrite = async (lines) => {
    const temp = `${options.file}.${process.pid}.${(rewrites += 1)}.tmp`
    try {
      await writeFile(temp, `${lines.slice(-ON_DISK).join('\n')}\n`, 'utf8')
      await rename(temp, options.file)
    } catch (error) {
      // A failed trim must not leave litter beside the log it failed to trim.
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  return {
    /**
     * @param {object} report - whatever the panel sent; unknown fields are dropped
     * @returns {object | null} the stored entry, or null when there was nothing to store
     */
    record(report) {
      if (report === null || typeof report !== 'object' || Array.isArray(report)) return null
      const entry = {
        at: now(),
        scope: trim(report.scope),
        status: Number.isFinite(report.status) ? Number(report.status) : 0,
        reason: trim(report.reason),
        message: trim(report.message),
        url: trim(report.url),
      }
      if (entry.message === '' && entry.reason === '' && entry.status === 0) return null
      entries = [...entries, entry].slice(-MEMORY)
      writes = writes
        .then(async () => {
          await appendFile(options.file, `${JSON.stringify(entry)}\n`, 'utf8')
          // Keep the file bounded without a rotation scheme: read, trim, rewrite.
          const text = await readFile(options.file, 'utf8')
          const lines = text.split('\n').filter((line) => line.trim() !== '')
          if (lines.length > ON_DISK) await rewrite(lines)
        })
        .catch((error) => options.logger?.warn?.(`dsh-global-todo: 诊断记录写入失败（${String(error?.message ?? error)}）`))
      return entry
    },
    /** @returns {object[]} newest first */
    recent() {
      void load()
      return entries.slice(-RECENT).reverse()
    },
    /**
     * Wait for the queued writes.
     *
     * Exposed because the alternative is a test that sleeps and hopes — which is exactly
     * how a timing-dependent assertion reached CI and failed only on the slower runtime.
     */
    async flush() {
      await writes
      return entries.length
    },
    /** Warm the in-memory copy at startup so `/health` survives a restart. */
    async load() {
      await load()
      return entries
    },
  }
}
