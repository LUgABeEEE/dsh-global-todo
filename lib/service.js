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
export const FILTERS = Object.freeze(['all', 'active', 'open', 'doing', 'done', 'cancelled', 'overdue'])

/** Sort keys the panel and the tools may ask for. */
export const SORTS = Object.freeze(['created', 'updated', 'due', 'priority'])

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }

/**
 * @param {{ store: object, config?: object, logger?: object, now?: () => number }} options
 */
export function createService(options) {
  const store = options.store
  const config = options.config ?? {}
  const logger = options.logger
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
   * @returns {object[]}
   */
  function select(todos, query = {}) {
    const filter = typeof query.status === 'string' && query.status !== '' ? query.status : 'all'
    if (!FILTERS.includes(filter)) {
      throw new TodoError('invalid-status', `筛选条件只能是 ${FILTERS.join(' / ')}，收到 ${filter}`)
    }
    const needle = typeof query.query === 'string' ? query.query.trim().toLowerCase() : ''
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
      if (needle !== '') {
        const haystack = [
          todo.title,
          todo.description,
          todo.tags.join(' '),
          todo.links.map((link) => `${link.title} ${link.value}`).join(' '),
        ]
          .join('\n')
          .toLowerCase()
        if (!haystack.includes(needle)) return false
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
    return out.slice(0, limit)
  }

  /**
   * @param {{ status?: string, query?: string, tag?: string, sort?: string, limit?: number }} [query]
   * @returns {Promise<{ todos: object[], counts: object, matched: number }>}
   */
  async function list(query = {}) {
    const todos = await store.all()
    const selected = select(todos, query)
    return { todos: selected, counts: counts(todos, now()), matched: selected.length }
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
      '请扫一下我们这个对话里需要**跨会话跟进**的事，用 global_todo_capture 一次登记（可以多条）。',
      '',
      '只记真正需要跟进的：等对方回复、待确认的决定、答应别人的事、还没收尾的一步、需要另开一个会话或另一台机器继续的事。',
      '不要记：你自己这一步就能做完的、我们这个会话的计划、纯闲聊、已经完成的事。宁可少记。',
      '每条给一个说清「要做什么」的标题，必要时补描述、挂上相关文档路径或网址，并标级别（P0 紧急 / P1 高 / P2 常规 / P3 低）。',
      '',
      '记完用一句话汇总，不要逐条复述。',
    ].join('\n')
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
    complete,
    findBySession,
    remove,
    restore,
    addLink,
    removeLink,
    recordDispatch,
    select,
    dispatchPrompt,
    capturePrompt,
    stats,
    describe: () => store.describe(),
    statuses: STATUSES,
  }
}
