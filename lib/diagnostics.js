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

import { appendFile, readFile, writeFile } from 'node:fs/promises'

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
          if (lines.length > ON_DISK) await writeFile(options.file, `${lines.slice(-ON_DISK).join('\n')}\n`, 'utf8')
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
