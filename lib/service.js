/**
 * The service layer: one place where the list changes.
 *
 * Both writers — the human through the panel's HTTP routes and the agent
 * through its tools — call these functions, so validation, the audit trail and
 * the write lock cannot diverge between them. A rule added here applies to both
 * sides at once; that is the whole point of the file.
 *
 * @module dsh-global-todo/service
 */

import { existsSync } from 'node:fs'

import { TodoError } from './errors.js'
import { formatLink } from './links.js'
import {
  LIMITS,
  STATUSES,
  addLink as addLinkTo,
  addNote as addNoteTo,
  applyPatch,
  counts,
  createTodo,
  completeTodo,
  isOverdue,
  newId,
  normalizeActor,
  normalizeStored,
  pushActivity,
  recordDispatch as recordDispatchOn,
  removeLink as removeLinkFrom,
  setStatus as setStatusOn,
} from './model.js'

/** Filters the panel and the tools may ask for. */
export const FILTERS = Object.freeze(['all', 'active', 'open', 'doing', 'done', 'cancelled', 'archived', 'overdue'])

/** Sort keys the panel and the tools may ask for. */
export const SORTS = Object.freeze(['created', 'updated', 'due', 'priority'])

// Every level the record can hold, or the comparator silently produces NaN for
// the missing one and the highest-priority items sort last. `urgent` was added
// to the model without this table, so `sort=priority` put P0 at the bottom.
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }

/**
 * Fold imported records into the current list: a known id wins, a new one appends.
 *
 * The existing order is kept, so a merge does not reshuffle a list the person has
 * arranged by hand.
 *
 * @param {object[]} current
 * @param {object[]} incoming
 * @returns {object[]}
 */
function mergeById(current, incoming) {
  const byId = new Map(incoming.map((todo) => [todo.id, todo]))
  const out = current.map((todo) => byId.get(todo.id) ?? todo)
  const known = new Set(current.map((todo) => todo.id))
  for (const todo of incoming) {
    if (!known.has(todo.id)) out.push(todo)
  }
  return out
}

/**
 * @param {{ store: object, config?: object, logger?: object, now?: () => number }} options
 */
export function createService(options) {
  const store = options.store
  const config = options.config ?? {}
  const logger = options.logger
  // Optional runtime counters, reported by /health. Absent in most tests, which
  // is why every recording call below is guarded.
  const metrics = options.metrics
  const now = options.now ?? (() => Date.now())
  const requireExistingFiles = config.requireExistingFiles !== false
  const activityLimit = config.activityLimit ?? LIMITS.activity

  /** Link options for {@link import('./links.js').normalizeLink}. */
  const linkOptions = () => ({
    requireExistingFiles,
    exists: (candidate) => {
      try {
        return existsSync(candidate)
      } catch {
        return false
      }
    },
  })

  const modelOptions = (by) => ({
    now: now(),
    by,
    activityLimit,
    usedIds: [],
    ...linkOptions(),
  })

  /**
   * @param {{ todos: object[] }} doc
   * @param {string} id
   * @returns {object}
   */
  function requireTodo(doc, id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TodoError('not-found', '缺少待办 id')
    }
    const todo = doc.todos.find((candidate) => candidate.id === id.trim())
    if (todo === undefined) throw new TodoError('not-found', `没有这条待办：${id}`)
    return todo
  }

  /**
   * @param {object[]} todos
   * @param {{ status?: string, query?: string, tag?: string, sort?: string, limit?: number }} [query]
   * @returns {{ todos: object[], matched: number }} the page and how many matched before it
   */
  /** Friendly level aliases, so search can be written the way the panel talks. */
  const LEVEL_ALIAS = Object.freeze({ p0: 'urgent', p1: 'high', p2: 'normal', p3: 'low' })

  /**
   * Split a search string into field filters and free text.
   *
   * `tag:发布`, `is:overdue`, `has:link`, `level:p0` — all optional, all combinable,
   * and anything else is matched as text, so a plain search keeps working exactly as
   * it did before.
   *
   * @param {string} raw
   * @returns {{ text: string[], tags: string[], levels: string[], flags: string[] }}
   */
  function parseQuery(raw) {
    const parsed = { text: [], tags: [], levels: [], flags: [] }
    for (const token of String(raw).split(/\s+/)) {
      if (token === '') continue
      const lower = token.toLowerCase()
      if (lower.startsWith('tag:') && lower.length > 4) parsed.tags.push(lower.slice(4))
      else if (lower.startsWith('#') && lower.length > 1) parsed.tags.push(lower.slice(1))
      else if (lower.startsWith('level:') && lower.length > 6) {
        const value = lower.slice(6)
        parsed.levels.push(LEVEL_ALIAS[value] ?? value)
      } else if (lower.startsWith('is:') && lower.length > 3) parsed.flags.push(lower)
      else if (lower.startsWith('has:') && lower.length > 4) parsed.flags.push(lower)
      else parsed.text.push(lower)
    }
    return parsed
  }

  /**
   * @param {object} todo
   * @param {{ tags: string[], levels: string[], flags: string[] }} parsed
   * @param {number} at
   * @returns {boolean}
   */
  function matchesSyntax(todo, parsed, at) {
    for (const tag of parsed.tags) {
      if (!todo.tags.some((candidate) => candidate.toLowerCase() === tag)) return false
    }
    for (const level of parsed.levels) {
      if (todo.priority !== level) return false
    }
    for (const flag of parsed.flags) {
      if (flag === 'is:overdue' && !isOverdue(todo, at)) return false
      if (flag === 'is:due' && (todo.dueAt === null || todo.dueAt === undefined)) return false
      if (flag === 'is:active' && todo.status !== 'open' && todo.status !== 'doing') return false
      if (flag === 'has:link' && todo.links.length === 0) return false
      if (flag === 'has:note' && (todo.notes ?? []).length === 0) return false
      if (flag.startsWith('is:') && ['open', 'doing', 'done', 'cancelled'].includes(flag.slice(3))) {
        if (todo.status !== flag.slice(3)) return false
      }
    }
    return true
  }

  function select(todos, query = {}) {
    const filter = typeof query.status === 'string' && query.status !== '' ? query.status : 'all'
    if (!FILTERS.includes(filter)) {
      throw new TodoError('invalid-status', `筛选条件只能是 ${FILTERS.join(' / ')}，收到 ${filter}`)
    }
    const rawQuery = typeof query.query === 'string' ? query.query.trim() : ''
    const parsed = parseQuery(rawQuery)
    const needle = parsed.text.join(' ')
    const tag = typeof query.tag === 'string' ? query.tag.trim().replace(/^#/, '').toLowerCase() : ''

    let out = todos.filter((todo) => {
      // The status filter and the text/tag filters are independent conditions:
      // asking for `active` must not silently drop the search term.
      const statusMatches =
        filter === 'all'
          ? true
          : filter === 'active'
            ? todo.status === 'open' || todo.status === 'doing'
            : filter === 'overdue'
              ? isOverdue(todo, now())
              : todo.status === filter
      if (!statusMatches) return false
      if (tag !== '' && !todo.tags.some((candidate) => candidate.toLowerCase() === tag)) return false
      if (!matchesSyntax(todo, parsed, now())) return false
      if (parsed.text.length > 0) {
        const haystack = [
          todo.title,
          todo.description,
          (todo.notes ?? []).map((entry) => entry.text).join(' '),
          todo.tags.join(' '),
          todo.links.map((link) => `${link.title} ${link.value}`).join(' '),
        ]
          .join('\n')
          .toLowerCase()
        // Every free word must appear: "npm 发布" should not match either alone.
        if (!parsed.text.every((word) => haystack.includes(word))) return false
      }
      return true
    })

    const sort = typeof query.sort === 'string' && query.sort !== '' ? query.sort : 'created'
    if (!SORTS.includes(sort)) {
      throw new TodoError('invalid-body', `排序只能是 ${SORTS.join(' / ')}，收到 ${sort}`)
    }
    out = out.slice().sort((a, b) => {
      if (sort === 'updated') return b.updatedAt - a.updatedAt
      if (sort === 'due') {
        const left = a.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.dueAt)
        const right = b.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.dueAt)
        if (left !== right) return left - right
        return b.createdAt - a.createdAt
      }
      if (sort === 'priority') {
        const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        if (rank !== 0) return rank
        return b.createdAt - a.createdAt
      }
      return b.createdAt - a.createdAt
    })

    const limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 1000) : 200
    // matched is the count before the page is cut. Returning only the page made the
    // panel show 200 for a list of 350 with no way to tell -- the caller now has
    // enough to say 'showing 200 of 350' instead of quietly lying.
    return { todos: out.slice(0, limit), matched: out.length }
  }

  /**
   * @param {{ status?: string, query?: string, tag?: string, sort?: string, limit?: number }} [query]
   * @returns {Promise<{ todos: object[], counts: object, matched: number, truncated: boolean }>}
   */
  async function list(query = {}) {
    const todos = await store.all()
    const selected = select(todos, query)
    return {
      todos: selected.todos,
      counts: counts(todos, now()),
      matched: selected.matched,
      truncated: selected.matched > selected.todos.length,
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<object>}
   */
  async function get(id) {
    const todos = await store.all()
    return requireTodo({ todos }, id)
  }

  /**
   * @param {object} input
   * @param {{ by?: 'human' | 'agent', origin?: { dir?: string, sessionId?: string } }} [context]
   * @returns {Promise<object>} the created todo
   */
  async function create(input, context = {}) {
    return store.update((doc) => {
      const todo = createTodo(input, {
        ...modelOptions(context.by),
        usedIds: doc.todos.map((candidate) => candidate.id),
        ...(context.origin === undefined ? {} : { origin: context.origin }),
      })
      doc.todos.push(todo)
      metrics?.recordList?.('created', doc.todos.length)
      logger?.debug?.(`dsh-global-todo: created ${todo.id}`)
      return { next: doc.todos, result: todo }
    })
  }

  /**
   * @param {string} id
   * @param {object} patch
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, changed: string[] }>}
   */
  async function update(id, patch, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const changed = applyPatch(todo, patch, {
        ...modelOptions(context.by),
        ...linkOptions(),
      })
      return changed.length === 0 ? { result: { todo, changed } } : { next: doc.todos, result: { todo, changed } }
    })
  }

  /**
   * @param {string} id
   * @param {string} status
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<object>}
   */
  async function setStatus(id, status, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const changed = setStatusOn(todo, status, modelOptions(context.by))
      return changed ? { next: doc.todos, result: todo } : { result: todo }
    })
  }

  /**
   * Put a wrongly-finished todo back on the list.
   *
   * Deliberately narrower than {@link setStatus}: only a `done` or `cancelled` record
   * can be reopened, so this can never grow into a second way to *finish* something.
   * A record that is already open (or in progress) is refused rather than reported as
   * a success — in that case the caller's premise is what is wrong, and saying so is
   * the honest answer.
   *
   * @param {string} id
   * @param {{ by?: 'human' | 'agent', reason?: string }} [context]
   * @returns {Promise<object>} the reopened todo
   */
  async function reopen(id, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      if (todo.status !== 'done' && todo.status !== 'cancelled') {
        throw new TodoError(
          'invalid-status',
          `这条待办的状态是 ${todo.status}，不是 done / cancelled，没有需要复open的完成标记`,
        )
      }
      const changed = setStatusOn(todo, 'open', { ...modelOptions(context.by), reason: context.reason })
      return changed ? { next: doc.todos, result: todo } : { result: todo }
    })
  }

  /**
   * Mark a todo finished, with the evidence the work produced.
   *
   * @param {string} id
   * @param {{ summary?: string, artifacts?: unknown[], sessionId?: string }} evidence
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, changed: boolean }>}
   */
  async function complete(id, evidence = {}, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const changed = completeTodo(todo, evidence, { ...modelOptions(context.by ?? 'agent'), ...linkOptions() })
      return { next: doc.todos, result: { todo, changed } }
    })
  }

  /**
   * Append a progress note.
   *
   * @param {string} id
   * @param {string} text
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, note: object }>}
   */
  async function note(id, text, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const created = addNoteTo(todo, text, modelOptions(context.by ?? 'agent'))
      metrics?.recordList?.('noted')
      return { next: doc.todos, result: { todo, note: created } }
    })
  }

  /**
   * A copy of the todo whose file attachments carry `missing` when the file is gone.
   *
   * Computed on read, never stored: a file that moves back must stop being flagged,
   * and a stale flag in the record would outlive the problem.
   *
   * @param {object} todo
   * @returns {object}
   */
  function annotateLinks(todo) {
    const checker = linkOptions().exists
    const check = checker ?? (() => true)
    return {
      ...todo,
      links: todo.links.map((link) => {
        if (link.kind !== 'file') return { ...link }
        let present = true
        try {
          present = check(link.value) !== false
        } catch {
          present = true
        }
        return present ? { ...link } : { ...link, missing: true }
      }),
    }
  }

  /**
   * The open todo a session is responsible for, if any.
   *
   * Used by the completion watcher: a session's turn ending must find exactly
   * the record it was handed.
   *
   * @param {string} sessionId
   * @returns {Promise<object | null>}
   */
  async function findBySession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const todos = await store.all()
    return (
      todos.find((todo) => todo.sessionId === sessionId && (todo.status === 'open' || todo.status === 'doing')) ?? null
    )
  }

  /**
   * Put a removed record back exactly as it was.
   *
   * This is what the panel's undo button calls: the id, the creation time, the
   * attachments and the activity trail all come back, so an accidental delete
   * costs nothing. A record whose id is taken is refused rather than merged.
   *
   * @param {unknown} record - a full todo record
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<object>}
   */
  async function restore(record, context = {}) {
    return store.update((doc) => {
      const todo = normalizeStored(record, { activityLimit })
      if (todo === null) throw new TodoError('invalid-body', '这条记录无法还原：缺少 id 或标题')
      if (doc.todos.some((candidate) => candidate.id === todo.id)) {
        throw new TodoError('invalid-body', `id 已存在，不能还原：${todo.id}`)
      }
      todo.updatedAt = now()
      todo.updatedBy = normalizeActor(context.by)
      pushActivity(todo, { kind: 'restored', by: context.by, at: now(), summary: todo.title }, activityLimit)
      doc.todos.push(todo)
      metrics?.recordList?.('restored', doc.todos.length)
      return { next: doc.todos, result: todo }
    })
  }

  /**
   * @param {string} id
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<object>} the removed todo
   */
  async function remove(id, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      doc.todos = doc.todos.filter((candidate) => candidate.id !== todo.id)
      metrics?.recordList?.('removed', doc.todos.length)
      logger?.debug?.(`dsh-global-todo: removed ${todo.id} by ${context.by ?? 'human'}`)
      return { next: doc.todos, result: todo }
    })
  }

  /**
   * @param {string} id
   * @param {unknown} link
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, added: boolean, link: object }>}
   */
  async function addLink(id, link, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const outcome = addLinkTo(todo, link, {
        ...modelOptions(context.by),
        ...linkOptions(),
      })
      return outcome.added
        ? { next: doc.todos, result: { todo, added: true, link: outcome.link } }
        : { result: { todo, added: false, link: outcome.link } }
    })
  }

  /**
   * @param {string} id
   * @param {{ index?: number, key?: string }} ref
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ todo: object, removed: object | null }>}
   */
  async function removeLink(id, ref, context = {}) {
    return store.update((doc) => {
      const todo = requireTodo(doc, id)
      const removed = removeLinkFrom(todo, ref ?? {}, modelOptions(context.by))
      return removed === null ? { result: { todo, removed: null } } : { next: doc.todos, result: { todo, removed } }
    })
  }

  /**
   * Record the outcome of a hand-off. Never throws for a missing todo: the
   * caller is already on an error path and must not lose the original reason.
   *
   * @param {string} id
   * @param {{ mode: string, sessionId?: string, ok: boolean, error?: string }} info
   * @returns {Promise<object | null>}
   */
  async function recordDispatch(id, info) {
    try {
      return await store.update((doc) => {
        const todo = requireTodo(doc, id)
        recordDispatchOn(todo, info, { now: now(), activityLimit })
        return { next: doc.todos, result: todo }
      })
    } catch (error) {
      logger?.warn?.(`dsh-global-todo: 记录派发结果失败（${id}）：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * @param {object} todo
   * @returns {string} the prompt a dispatched session receives
   */
  function dispatchPrompt(todo) {
    const lines = ['【全局待办 · 交给 Agent】', `待办：${todo.title}`]
    if (todo.description !== '') {
      lines.push('', '描述：', todo.description)
    }
    if (todo.links.length > 0) {
      lines.push('', '相关文档与地址：')
      for (const link of todo.links) {
        lines.push(`- ${link.kind === 'url' ? '地址' : '文档'}：${formatLink(link)}`)
      }
    }
    if (todo.dueAt !== null) lines.push('', `截止：${todo.dueAt}`)
    if (todo.tags.length > 0) lines.push(`标签：${todo.tags.join(', ')}`)
    lines.push('', `这条待办加入于 ${new Date(todo.createdAt).toISOString()}，id 是 ${todo.id}。`)
    lines.push('请现在开始处理它。')
    lines.push(
      `做完后调用 global_todo_done 工具，带上 id=${todo.id}、`
        + '`summary`（一句话：做了什么、结论是什么）和 `artifacts`（这次产出的文件绝对路径或相关网址）——'
        + '清单上留下的完成记录就是这些，缺了它「已完成」等于什么都没说。',
    )
    lines.push('做不完或做不了，就说明卡在哪里，**不要**把它标为完成。')
    return lines.join('\n')
  }

  /**
   * The message the panel injects when it asks a conversation to collect todos.
   *
   * It states both sides, like the system-prompt guidance: a conversation asked to
   * "capture things" will otherwise record its own plan and small talk.
   *
   * @returns {string}
   */
  function capturePrompt() {
    return [
      '【全局待办 · 抓取】',
      '扫一下我们这个对话里需要**跨会话跟进**的事，用 global_todo_capture 一次登记。',
      '',
      '**精炼、合并**（重要）：',
      '- 一件事只记**一条**；同一主题的零散小点**合并成一条**，写进那一条的描述里，不要拆成多条；',
      '- 标题一句话说清「要做什么」（别写成段落，也别抄原文）；',
      '- **宁可 1–3 条也不要 8 条**：只留真正需要跨会话/跨设备/等别人才能推进的事；',
      '- 已经讨论完、你能立刻做完、或者清单里**已经有**的，不要记。',
      '',
      '该记的：等对方回复、待确认的决定、答应别人的事、还没收尾且需要另开一个会话继续的一步。',
      '每条必要时补描述、挂上相关文档**绝对路径**或网址，并标级别（P0 紧急 / P1 高 / P2 常规 / P3 低）。',
      '',
      '记完用**一句话**汇总（例如「记了 2 条：X 与 Y」），不要逐条复述。',
    ].join('\n')
  }

  /**
   * The list exactly as it is stored.
   *
   * Deliberately the raw document, not the annotated shape `/list` returns: an
   * export is what a round trip has to hand back, and a `missing` flag or a live
   * session's directory are runtime facts that do not belong in it.
   *
   * @returns {Promise<{ version: number, todos: object[] }>}
   */
  async function exportDocument() {
    const doc = await store.read()
    return { version: doc.version, todos: doc.todos }
  }

  /**
   * Load a previously exported document back into the list.
   *
   * `replace` makes the list exactly the document, which is what a round trip
   * needs; `merge` updates by id and appends what is new, which is what restoring
   * a backup into a list that has since moved on needs. A record that cannot be
   * read fails the whole import: a partial write would be a silent loss, and that
   * is the one outcome this must never have.
   *
   * @param {unknown} input - the exported document, or a bare `{ todos }`
   * @param {{ mode?: string }} [context]
   * @returns {Promise<{ mode: string, imported: number, total: number, todos: object[] }>}
   */
  async function importDocument(input, context = {}) {
    const doc = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const raw = Array.isArray(doc.todos) ? doc.todos : []
    if (raw.length === 0) throw new TodoError('invalid-body', '这份 JSON 里没有待办：需要一个非空的 todos 数组')
    const mode = context.mode === 'merge' ? 'merge' : 'replace'
    const records = []
    const seen = new Set()
    for (const [index, item] of raw.entries()) {
      const todo = normalizeStored(item, { activityLimit })
      if (todo === null) throw new TodoError('invalid-body', `第 ${index + 1} 条无法读取：缺少 id 或标题`)
      if (seen.has(todo.id)) throw new TodoError('invalid-body', `第 ${index + 1} 条与前面的记录 id 重复：${todo.id}`)
      seen.add(todo.id)
      records.push(todo)
    }
    return store.update((existing) => {
      const todos = mode === 'merge' ? mergeById(existing.todos, records) : records
      metrics?.recordList?.('imports', todos.length)
      return {
        next: todos,
        result: { mode, imported: records.length, total: todos.length, todos },
      }
    })
  }

  /**
   * Apply one change to several todos.
   *
   * Each record goes through the same validation and trail as a single edit. A stale id is
   * reported in `unmatched` instead of failing the batch: a selection is a human gesture, and
   * one row that moved must not discard the other nine.
   *
   * @param {string[]} ids
   * @param {{ status?: string, addTags?: string[], removeTags?: string[] }} change
   * @param {{ by?: 'human' | 'agent' }} [context]
   * @returns {Promise<{ updated: number, ids: string[], unmatched: string[], errors: { id: string, error: string }[] }>}
   */
  async function bulk(ids, change = {}, context = {}) {
    const wanted = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.trim() !== '') : []
    if (wanted.length === 0) throw new TodoError('invalid-body', '要改哪些待办？给一个非空的 ids')
    const hasStatus = typeof change.status === 'string' && change.status !== ''
    const addTags = Array.isArray(change.addTags) ? change.addTags : []
    const removeTags = Array.isArray(change.removeTags) ? change.removeTags : []
    if (!hasStatus && addTags.length === 0 && removeTags.length === 0) {
      throw new TodoError('invalid-body', '批量修改需要 status / addTags / removeTags 之一')
    }
    const updated = []
    const unmatched = []
    const errors = []
    for (const id of wanted) {
      try {
        const todo = await store.update((doc) => {
          const target = doc.todos.find((candidate) => candidate.id === id)
          if (target === undefined) return { result: null }
          const patch = {}
          if (hasStatus) patch.status = change.status
          if (addTags.length > 0 || removeTags.length > 0) {
            const merged = new Map(target.tags.map((tag) => [tag.toLowerCase(), tag]))
            for (const tag of addTags) merged.set(String(tag).toLowerCase(), String(tag))
            for (const tag of removeTags) merged.delete(String(tag).toLowerCase())
            patch.tags = [...merged.values()]
          }
          const changed = applyPatch(target, patch, { ...modelOptions(context.by), ...linkOptions() })
          return changed.length === 0 ? { result: target } : { next: doc.todos, result: target }
        })
        if (todo === null) unmatched.push(id)
        else updated.push(id)
      } catch (error) {
        errors.push({ id, error: error instanceof TodoError ? error.message : String(error?.message ?? error) })
      }
    }
    return { updated: updated.length, ids: updated, unmatched, errors }
  }
  /** @returns {Promise<object>} counts for the panel header and tool summaries */
  async function stats() {
    const todos = await store.all()
    return counts(todos, now())
  }

  return {
    list,
    get,
    create,
    update,
    setStatus,
    reopen,
    complete,
    note,
    annotateLinks,
    findBySession,
    remove,
    restore,
    bulk,
    addLink,
    removeLink,
    recordDispatch,
    exportDocument,
    importDocument,
    select,
    dispatchPrompt,
    capturePrompt,
    stats,
    describe: () => store.describe(),
    statuses: STATUSES,
  }
}
