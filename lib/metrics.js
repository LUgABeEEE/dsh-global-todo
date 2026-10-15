/**
 * Runtime counters, reported through /health.
 *
 * Three observable facts: how hand-offs turn out, how often the agent tools are
 * called, and how the list grows. They are counted here and nowhere else, so a
 * caller cannot quietly disagree with the number it reports.
 *
 * In memory on purpose. These describe **this process**: a rate that survives a
 * restart without its attempts would be a guess wearing a number's clothes. The
 * counters therefore reset with the Host, and `since` says when.
 *
 * Nothing in the plugin's behaviour depends on this module: every recording call
 * is optional, and a Host that never mounts it simply has no `metrics` field in
 * /health.
 *
 * @module dsh-global-todo/metrics
 */

/**
 * @param {number} part
 * @param {number} whole
 * @returns {number | null} a 0..1 rate, or null when there is nothing to divide
 */
function rate(part, whole) {
  if (whole <= 0) return null
  return Math.round((part / whole) * 10000) / 10000
}

/**
 * @param {{ now?: () => number }} [options]
 */
export function createMetrics(options = {}) {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()

  const dispatch = { attempts: 0, ok: 0, failed: 0, byMode: {}, lastAt: null }
  const tools = { calls: 0, failed: 0, byName: {} }
  const list = {
    // How the list changed while this process was up, and where it ended.
    created: 0,
    removed: 0,
    restored: 0,
    imports: 0,
    noted: 0,
    changes: 0,
    size: null,
    peak: null,
    lastChangeAt: null,
  }

  /**
   * Remember how big the list is now. `peak` is the high-water mark, which is
   * the honest way to show growth on a list that also shrinks.
   *
   * @param {unknown} size
   */
  function observeSize(size) {
    if (!Number.isInteger(size) || size < 0) return
    list.size = size
    list.peak = list.peak === null ? size : Math.max(list.peak, size)
  }

  /**
   * One list mutation.
   *
   * @param {'created' | 'removed' | 'restored' | 'imports' | 'noted'} event
   * @param {number} [size] - the list size after the change, when the caller knows it
   */
  function recordList(event, size) {
    if (typeof list[event] === 'number') list[event] += 1
    list.changes += 1
    list.lastChangeAt = now()
    if (size !== undefined) observeSize(size)
  }

  /**
   * One hand-off attempt. Every attempt lands here exactly once: the dispatcher
   * counts a success when it returns and a failure when it throws, so the two can
   * never disagree with each other.
   *
   * @param {{ ok?: boolean, mode?: string }} [info]
   */
  function recordDispatch(info = {}) {
    const mode = typeof info.mode === 'string' && info.mode !== '' ? info.mode : 'auto'
    dispatch.attempts += 1
    dispatch.lastAt = now()
    dispatch.byMode[mode] = (dispatch.byMode[mode] ?? 0) + 1
    if (info.ok === true) dispatch.ok += 1
    else dispatch.failed += 1
  }

  /**
   * One agent tool call. A tool that answered { ok: false } counts as a failed
   * call: the model asked for something and did not get it.
   *
   * @param {unknown} name
   * @param {unknown} ok
   */
  function recordTool(name, ok) {
    const key = typeof name === 'string' && name !== '' ? name : 'unknown'
    tools.calls += 1
    tools.byName[key] = (tools.byName[key] ?? 0) + 1
    if (ok !== true) tools.failed += 1
  }

  /**
   * @param {{ size?: number }} [extra] - a size to fold in before reporting
   * @returns {object} plain JSON, safe to embed in /health
   */
  function snapshot(extra = {}) {
    if (extra.size !== undefined) observeSize(extra.size)
    return {
      since: startedAt,
      uptimeMs: now() - startedAt,
      list: { ...list },
      dispatch: {
        ...dispatch,
        byMode: { ...dispatch.byMode },
        successRate: rate(dispatch.ok, dispatch.attempts),
      },
      tools: { ...tools, byName: { ...tools.byName } },
    }
  }

  return { observeSize, recordList, recordDispatch, recordTool, snapshot }
}
