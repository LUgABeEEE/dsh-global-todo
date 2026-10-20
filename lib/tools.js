/**
 * Agent-facing tools.
 *
 * Ten `global_todo_*` tools. The prefix avoids DSH's built-in `todo_write`
 * (the agent's own per-session plan, a different thing with a different owner)
 * and any other plugin's `todo_*` namespace.
 *
 * Every tool delegates to the same service the panel uses. Errors are returned
 * as ordinary tool values — `{ ok: false, reason, error }` — so the model gets
 * an actionable message instead of a stack trace, and a failed tool never takes
 * down the turn.
 *
 * @module dsh-global-todo/tools
 */

import { CAPTURE_REASONS, findDuplicate } from './capture.js'
import { asTodoError } from './errors.js'
import { formatLink } from './links.js'
import { LIMITS, PRIORITIES, PRIORITY_LABELS, STATUSES } from './model.js'

const text = (value) => [{ type: 'text', text: value }]

const STEPS_INPUT = {
  type: 'array',
  description:
    '要做成的几步（可选，最多 ' + LIMITS.steps + ' 条）。每步一句话；已完成的写 { text, done: true }。'
    + '派发时会把它们作为编号计划交给 Agent。',
  items: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: { text: { type: 'string' }, done: { type: 'boolean' } },
        required: ['text'],
        additionalProperties: false,
      },
    ],
  },
}

const STEPS_SHAPE = {
  type: 'array',
  items: {
    type: 'object',
    properties: { text: { type: 'string' }, done: { type: 'boolean' } },
    required: ['text'],
    additionalProperties: false,
  },
}

const LINKS_INPUT = {
  type: 'array',
  description:
    '相关文档与地址。字符串写法按内容自动判别：http(s):// 开头算地址，其余必须是以 / 或盘符开头的绝对路径（文档原地引用，不复制内容）。也可给对象 { kind: "url"|"file", value, title }。',
  items: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['url', 'file'] },
          value: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    ],
  },
}

/** One todo's worth of input, shared by `add` and `capture`. */
const ITEM_PROPERTIES = {
  title: { type: 'string', description: `一句话说清要做什么（最多 ${LIMITS.title} 字）` },
  description: { type: 'string', description: '补充说明、验收标准、已知的坑' },
  links: LINKS_INPUT,
  tags: { type: 'array', items: { type: 'string' }, description: `标签，最多 ${LIMITS.tags} 个` },
  priority: { type: 'string', enum: [...PRIORITIES], description: 'P0 紧急 / P1 高 / P2 常规（缺省）/ P3 低' },
  dueAt: { type: 'string', description: 'ISO-8601 截止时间，例如 2026-10-20T10:00 或 2026-10-20' },
}

/**
 * A completion record as the model sees it: what finished it, what was said, and
 * what it produced.
 */
const COMPLETION_SHAPE = {
  oneOf: [
    {
      type: 'object',
      properties: {
        at: { type: 'integer', description: '完成时间（epoch 毫秒）' },
        by: { type: 'string', enum: ['human', 'agent'] },
        summary: { type: 'string', description: '完成说明：做了什么' },
        sessionId: { type: 'string', description: '在哪个会话里完成的；空串表示不是会话自动收尾' },
        artifacts: {
          type: 'array',
          description: '这次工作产出的文件（本地绝对路径）或相关地址',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['url', 'file'] }, value: { type: 'string' }, title: { type: 'string' } },
            required: ['kind', 'value', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['at', 'by', 'summary', 'sessionId', 'artifacts'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
}

const TODO_SHAPE = {  type: 'object',
  properties: {
    id: { type: 'string' },
    seq: { type: 'integer', description: '给人看的编号（#42）；0 表示尚未分配' },
    title: { type: 'string' },
    description: { type: 'string' },
    status: { type: 'string', enum: [...STATUSES] },
    priority: { type: 'string', enum: [...PRIORITIES] },
    dueAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    tags: { type: 'array', items: { type: 'string' } },
    steps: STEPS_SHAPE,
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['url', 'file'] },
          value: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['kind', 'value', 'title'],
      },
    },
    createdAt: { type: 'integer', description: '加入时间（epoch 毫秒）' },
    createdAtIso: { type: 'string' },
    createdBy: { type: 'string', enum: ['human', 'agent'] },
    updatedAt: { type: 'integer' },
    doneAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    sessionId: { type: 'string', description: '已绑定的会话 id；空串表示还没交给过 Agent' },
    originDir: { type: 'string', description: '这条待办是在哪个工作目录里写的；空串表示未知' },
    originSessionId: { type: 'string', description: '写入它的会话 id；空串表示来自界面而不是某个会话' },
    completion: COMPLETION_SHAPE,
    notes: {
      type: 'array',
      description: '进展记录（追加式，最近的在后）：谁在什么时候说了什么',
      items: {
        type: 'object',
        properties: {
          at: { type: 'integer', description: '时间（epoch 毫秒）' },
          by: { type: 'string', enum: ['human', 'agent'] },
          text: { type: 'string' },
        },
        required: ['at', 'by', 'text'],
        additionalProperties: false,
      },
    },
    lastDispatch: {
      oneOf: [{ type: 'object' }, { type: 'null' }],
      description: '最近一次派发：{ at, mode, ok, sessionId?, error? }；null 表示从未派发',
    },
    overdue: { type: 'boolean' },
  },
  required: ['id', 'title', 'status', 'priority', 'createdAt', 'createdAtIso', 'createdBy'],
}

/**
 * @param {object} todo
 * @param {number} now
 * @returns {object} the structured projection models and the UI both consume
 */
export function presentTodo(todo, now = Date.now()) {
  const due = todo.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(todo.dueAt)
  return {
    id: todo.id,
    seq: todo.seq ?? 0,
    title: todo.title,
    description: todo.description,
    status: todo.status,
    priority: todo.priority,
    dueAt: todo.dueAt,
    tags: [...todo.tags],
    steps: (todo.steps ?? []).map((step) => ({ text: step.text, done: step.done === true })),
    links: todo.links.map((link) => ({ ...link })),
    createdAt: todo.createdAt,
    createdAtIso: new Date(todo.createdAt).toISOString(),
    createdBy: todo.createdBy,
    updatedAt: todo.updatedAt,
    doneAt: todo.doneAt,
    sessionId: todo.sessionId,
    originDir: todo.originDir ?? '',
    originSessionId: todo.originSessionId ?? '',
    notes: (todo.notes ?? []).map((entry) => ({ at: entry.at, by: entry.by, text: entry.text })),
    // Present so an agent can see it left a claim waiting: a record an agent finished is
    // not settled until a person confirms it, and saying so beats assuming it landed.
    review: todo.review?.pending === true ? { pending: true, at: todo.review.at, by: todo.review.by } : null,
    completion:
      todo.completion === null || todo.completion === undefined
        ? null
        : {
            at: todo.completion.at,
            by: todo.completion.by,
            summary: todo.completion.summary,
            sessionId: todo.completion.sessionId,
            artifacts: todo.completion.artifacts.map((link) => ({ ...link })),
          },
    lastDispatch: todo.lastDispatch === null || todo.lastDispatch === undefined ? null : { ...todo.lastDispatch },
    overdue: Number.isFinite(due) && due < now && todo.status !== 'done' && todo.status !== 'cancelled',
  }
}

/**
 * @param {object} todo
 * @returns {string} one readable line: status, title, id, age, extras
 */
export function todoLine(todo) {
  const mark = todo.status === 'done' ? 'x' : todo.status === 'doing' ? '~' : todo.status === 'cancelled' ? '-' : ' '
  const label = Number.isInteger(todo.seq) && todo.seq > 0 ? `#${todo.seq} ` : ''
  const parts = [`- [${mark}] ${label}${todo.title}  id=${todo.id}`, `加入于 ${new Date(todo.createdAt).toISOString()}`]
  if (todo.priority !== 'normal') parts.push(PRIORITY_LABELS[todo.priority] ?? todo.priority)
  if (todo.dueAt !== null) parts.push(`截止 ${todo.dueAt}`)
  if (todo.tags.length > 0) parts.push(todo.tags.map((tag) => `#${tag}`).join(' '))
  if (todo.links.length > 0) {
    parts.push(`${todo.links.length} 个附件（${todo.links.map((link) => link.title).join('、')}）`)
  }
  if (todo.sessionId !== '') parts.push(`已交给会话 ${todo.sessionId}`)
  return parts.join('  ')
}

/**
 * @param {object} todo
 * @returns {string} the multi-line block used by `get` and by write results
 */
export function todoDetail(todo) {
  const lines = [todoLine(todo)]
  if (todo.description !== '') lines.push('', '描述：', todo.description)
  if (todo.links.length > 0) {
    lines.push('', '附件：')
    for (const link of todo.links) lines.push(`- [${link.kind}] ${formatLink(link)}`)
  }
  if (Array.isArray(todo.notes) && todo.notes.length > 0) {
    lines.push('', '进展：')
    for (const entry of todo.notes.slice(-5)) {
      lines.push(`- ${new Date(entry.at).toISOString()}（${entry.by}）${entry.text}`)
    }
  }
  if (todo.completion !== null && todo.completion !== undefined) {
    lines.push('', `完成：${new Date(todo.completion.at).toISOString()}（${todo.completion.by}）`)
    if (todo.completion.summary !== '') lines.push(todo.completion.summary)
    if (todo.completion.artifacts.length > 0) {
      lines.push('产出：')
      for (const link of todo.completion.artifacts) lines.push(`- [${link.kind}] ${formatLink(link)}`)
    }
  }
  if (todo.lastDispatch !== null && todo.lastDispatch !== undefined) {
    const when = new Date(todo.lastDispatch.at).toISOString()
    lines.push(
      '',
      todo.lastDispatch.ok
        ? `最近派发：${when}（${todo.lastDispatch.mode} → ${todo.lastDispatch.sessionId ?? '?'}）`
        : `最近派发失败：${when}（${todo.lastDispatch.mode}：${todo.lastDispatch.error ?? '未知原因'}）`,
    )
  }
  return lines.join('\n')
}

/**
 * Wrap a service call so a rejection becomes a normal tool result.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<{ ok: true, value: T } | { ok: false, reason: string, error: string }>}
 */
async function attempt(run) {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    const wrapped = asTodoError(error)
    return { ok: false, reason: wrapped.code, error: wrapped.message }
  }
}

/**
 * Where a tool call came from.
 *
 * `execute(args, exec)` hands us the calling agent, so a todo written during a
 * conversation can remember that conversation's working directory — which is
 * what lets a later hand-off open the new session in the same place.
 *
 * Every read is defensive: `exec` is optional, and a missing shape must degrade
 * to "unknown origin", never to an exception.
 *
 * @param {unknown} exec
 * @returns {{ dir: string, sessionId: string }}
 */
function originOf(exec) {
  try {
    const agent = exec?.agent
    const header = agent?.session?.header
    const dir = typeof header?.cwd === 'string' ? header.cwd : ''
    const sessionId =
      typeof agent?.id === 'string' ? agent.id : typeof agent?.session?.id === 'string' ? agent.session.id : ''
    return { dir, sessionId }
  } catch {
    return { dir: '', sessionId: '' }
  }
}

/**
 * Build the tool definitions.
 *
 * @param {object} service - {@link import('./service.js').createService} result
 * @param {{ now?: () => number, metrics?: object }} [options]
 * @returns {object[]} definitions for `ctx.tools.register`
 */
export function createTools(service, options = {}) {
  const now = options.now ?? (() => Date.now())
  // Optional counters for /health; when absent the definitions ship untouched.
  const metrics = options.metrics

  const definitions = [
    {
      name: 'global_todo_add',
      description:
        '把一件事记进「全局待办」——一份跨会话、跨工作区、人和 Agent 共用的清单（不是本会话的 todo_write 计划）。'
        + '可以带描述、相关文档与地址、标签、优先级和截止时间。加入时间由系统记录，不需传。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: `一句话说清要做什么（最多 ${LIMITS.title} 字）` },
          description: { type: 'string', description: '补充说明、验收标准、已知的坑' },
          links: LINKS_INPUT,
          steps: STEPS_INPUT,
          tags: { type: 'array', items: { type: 'string' }, description: `标签，最多 ${LIMITS.tags} 个` },
          priority: { type: 'string', enum: [...PRIORITIES], description: 'P0 紧急 / P1 高 / P2 常规（缺省）/ P3 低' },
          dueAt: { type: 'string', description: 'ISO-8601 截止时间，例如 2026-10-20T10:00 或 2026-10-20' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, todo: TODO_SHAPE, reason: { type: 'string' }, error: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`没有记录成功：${value.error ?? value.reason ?? '未知原因'}`)
          return text(`已记入全局待办：\n${todoDetail(value.todo)}`)
        },
      },
      async execute(args, exec) {
        const outcome = await attempt(() => service.create(args ?? {}, { by: 'agent', origin: originOf(exec) }))
        if (outcome.ok !== true) return outcome
        return { ok: true, todo: presentTodo(outcome.value, now()) }
      },
    },

    {
      name: 'global_todo_capture',
      description:
        '把一次工作里攒下的多件事**一次性**记进全局待办（批量抓取）。'
        + '两种时机用它：用户说「抓一下待办 / 整理一下要跟进的」，你扫一遍最近的对话把该跟进的事提出来；'
        + '或者你自己在一轮里发现好几件需要跨会话跟进的事。'
        + '逐条校验：某条不合法只跳过那一条并在 skipped 里说明原因，其余照常写入，不用整批重来。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '要登记的条目，按重要性从高到低排列（列表会按加入时间倒序展示，先写的更靠前）',
            items: { type: 'object', properties: ITEM_PROPERTIES, required: ['title'], additionalProperties: false },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            count: { type: 'integer', description: '成功写入的条数' },
            todos: { type: 'array', items: TODO_SHAPE },
            skipped: {
              type: 'array',
              description: '被跳过的条目及原因',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, error: { type: 'string' } },
                required: ['title', 'error'],
                additionalProperties: false,
              },
            },
          },
          required: ['ok', 'count', 'todos', 'skipped'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          if (value.count === 0) {
            return text(
              `一条都没写进去。${value.skipped.length === 0 ? '没有给出条目。' : ''}`
              + value.skipped.map((item) => `\n- 「${item.title}」：${item.error}`).join(''),
            )
          }
          const lines = [`已登记 ${value.count} 条全局待办：`]
          for (const todo of value.todos) lines.push(todoLine(todo))
          if (value.skipped.length > 0) {
            lines.push('', `跳过 ${value.skipped.length} 条：`)
            for (const item of value.skipped) lines.push(`- 「${item.title}」：${item.error}`)
          }
          return text(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        const items = Array.isArray(args?.items) ? args.items : []
        const origin = originOf(exec)
        const todos = []
        const skipped = []
        // The quality gate decides per item: exact title, a close paraphrase within the
        // recent window, or the same errand finished days ago. One lookup of everything —
        // done and archived rows matter too, which the active-only lookup used to miss.
        let existing = []
        try {
          existing = (await service.list({ status: 'all', limit: 1000 })).todos
        } catch {
          existing = []
        }
        const nowMs = now()
        for (const item of items) {
          const verdict = findDuplicate({ title: item?.title, existing, now: nowMs })
          if (verdict.duplicate === true) {
            skipped.push({
              title: String(item?.title ?? '(无标题)'),
              error: CAPTURE_REASONS[verdict.reason] ?? '清单里已有重复条目，未重复登记',
            })
            continue
          }
          const outcome = await attempt(() => service.create(item ?? {}, { by: 'agent', origin }))
          if (outcome.ok === true) {
            todos.push(presentTodo(outcome.value, now()))
            // Later items in the same batch must see this one as existing.
            existing.push(outcome.value)
          }
          else skipped.push({ title: String(item?.title ?? '(无标题)'), error: outcome.error })
        }
        return { ok: todos.length > 0, count: todos.length, todos, skipped }
      },
    },

    {
      name: 'global_todo_list',
      description:
        '查「全局待办」。默认返回未完成（active = open + doing）的条目，按加入时间倒序。'
        + '每条都会带上加入时间；带附件的会列出附件标题。'
        + '结果超过 limit 时 truncated=true，matched 说明一共匹配了多少条。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['all', 'active', 'open', 'doing', 'done', 'cancelled', 'archived', 'overdue'],
            description: '缺省 active',
          },
          query: { type: 'string', description: '在标题、描述、标签、附件里模糊匹配' },
          tag: { type: 'string' },
          sort: { type: 'string', enum: ['created', 'updated', 'due', 'priority'], description: '缺省 created' },
          limit: { type: 'integer', description: '缺省 50，最多 500' },
        },
        required: [],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            counts: { type: 'object' },
            todos: { type: 'array', items: TODO_SHAPE },
            // Present only when the page was cut; the model should know it is not
            // looking at the whole match set before it concludes anything.
            matched: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
          required: ['count', 'counts', 'todos'],
        },
        render: (_args, value) => {
          if (value.count === 0) {
            return text(
              `没有符合条件的待办。（当前共 ${value.counts.total} 条：未完成 ${value.counts.open + value.counts.doing}、已完成 ${value.counts.done}）`,
            )
          }
          const lines = value.todos.map((todo) => todoLine(todo))
          const cut =
            value.truncated === true
              ? `\n（只显示前 ${value.count} 条，共 ${value.matched} 条匹配；用 status / query / limit 缩小范围）`
              : ''
          return text(
            `${value.count} 条待办（全库 ${value.counts.total} 条，逾期 ${value.counts.overdue} 条）：\n${lines.join('\n')}${cut}`,
          )
        },
      },
      async execute(args) {
        const query = args ?? {}
        const outcome = await attempt(() =>
          service.list({
            status: query.status ?? 'active',
            query: query.query,
            tag: query.tag,
            sort: query.sort,
            limit: Number.isInteger(query.limit) ? Math.min(query.limit, 500) : 50,
          }),
        )
        if (outcome.ok !== true) return outcome
        return {
          count: outcome.value.todos.length,
          counts: outcome.value.counts,
          todos: outcome.value.todos.map((todo) => presentTodo(todo, now())),
          matched: outcome.value.matched,
          truncated: outcome.value.truncated,
        }
      },
    },

    {
      name: 'global_todo_get',
      description: '读一条全局待办的全文：描述、附件（文档与地址）、加入时间、派发记录。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, todo: TODO_SHAPE, reason: { type: 'string' }, error: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) =>
          value.ok === true ? text(todoDetail(value.todo)) : text(`读不到：${value.error ?? value.reason ?? '未知原因'}`),
      },
      async execute(args) {
        const outcome = await attempt(() => service.get(args?.id))
        if (outcome.ok !== true) return outcome
        return { ok: true, todo: presentTodo(outcome.value, now()) }
      },
    },

    {
      name: 'global_todo_update',
      description:
        '改一条全局待办。只传要改的字段；`dueAt: ""` 清空截止时间，`tags: []` 清空标签，`links` / `steps` 是整体替换（要单独加附件请用 global_todo_link），`status` 可以设为 archived（归档，不删除）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: [...PRIORITIES] },
          // `status` belongs here: marking something in progress used to require the tool
          // named `global_todo_done`, and archiving had no entry point at all.
          status: { type: 'string', enum: [...STATUSES], description: 'open / doing / done / cancelled / archived' },
          dueAt: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '空串或 null 表示清空' },
          tags: { type: 'array', items: { type: 'string' } },
          links: LINKS_INPUT,
          steps: STEPS_INPUT,
        },
        required: ['id'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            changed: { type: 'array', items: { type: 'string' } },
            todo: TODO_SHAPE,
            reason: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`没有改成：${value.error ?? value.reason ?? '未知原因'}`)
          if (value.changed.length === 0) return text(`没有字段需要改。\n${todoDetail(value.todo)}`)
          return text(`已改：${value.changed.join('、')}\n${todoDetail(value.todo)}`)
        },
      },
      async execute(args) {
        const { id, ...patch } = args ?? {}
        const outcome = await attempt(() => service.update(id, patch, { by: 'agent' }))
        if (outcome.ok !== true) return outcome
        return { ok: true, changed: outcome.value.changed, todo: presentTodo(outcome.value.todo, now()) }
      },
    },

    {
      name: 'global_todo_link',
      description:
        '给一条全局待办挂上相关文档或地址，或摘掉某一个。文档给绝对路径（原地引用，不复制内容）；地址给 http(s) 链接。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          add: LINKS_INPUT,
          remove: {
            type: 'array',
            description: '要摘掉的附件：给 value（原样字符串）或 0 基下标',
            items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            added: { type: 'integer' },
            removed: { type: 'integer' },
            todo: TODO_SHAPE,
            reason: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`附件没改成功：${value.error ?? value.reason ?? '未知原因'}`)
          const summary = [`新增 ${value.added} 个，摘掉 ${value.removed} 个`]
          if (value.todo.links.length > 0) {
            summary.push('当前附件：')
            for (const link of value.todo.links) summary.push(`- [${link.kind}] ${formatLink(link)}`)
          } else {
            summary.push('这条待办现在没有附件。')
          }
          return text(summary.join('\n'))
        },
      },
      async execute(args) {
        const id = args?.id
        const additions = Array.isArray(args?.add) ? args.add : []
        const removals = Array.isArray(args?.remove) ? args.remove : []
        const outcome = await attempt(async () => {
          let todo = await service.get(id)
          let added = 0
          let removed = 0
          for (const item of additions) {
            const result = await service.addLink(id, item, { by: 'agent' })
            todo = result.todo
            if (result.added) added += 1
          }
          for (const item of removals) {
            const ref = Number.isInteger(item) ? { index: item } : { key: String(item) }
            if (!Number.isInteger(item)) {
              // A bare string may name a value or a key; resolve it against the
              // current list so the model does not need to know our key format.
              const match = todo.links.find((link) => link.value === item || formatLink(link) === item)
              if (match === undefined) continue
              ref.key = `${match.kind}\u0000${match.value}`
            }
            const result = await service.removeLink(id, ref, { by: 'agent' })
            todo = result.todo
            if (result.removed !== null) removed += 1
          }
          return { todo, added, removed }
        })
        if (outcome.ok !== true) return outcome
        return {
          ok: true,
          added: outcome.value.added,
          removed: outcome.value.removed,
          todo: presentTodo(outcome.value.todo, now()),
        }
      },
    },

    {
      name: 'global_todo_note',
      description:
        '给一条全局待办**追加一条进展记录**（谁在什么时候说了什么，追加式、不改历史）。'
        + '用它报告：做到哪一步了、**卡在哪里**、需要用户做什么决定——'
        + '**不要**为了报告进展去改写待办的 description（那是用户自己的文字）。'
        + '真的做完了请用 global_todo_done。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string', description: `进展内容，最多 ${LIMITS.note} 字` },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, todo: TODO_SHAPE, reason: { type: 'string' }, error: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) =>
          value.ok === true
            ? text(`已记一条进展（共 ${(value.todo.notes ?? []).length} 条）\n${todoLine(value.todo)}`)
            : text(`进展没记上：${value.error ?? value.reason ?? '未知原因'}`),
      },
      async execute(args) {
        const outcome = await attempt(() => service.note(args?.id, args?.text ?? '', { by: 'agent' }))
        if (outcome.ok !== true) return outcome
        return { ok: true, todo: presentTodo(outcome.value.todo, now()) }
      },
    },

    {
      name: 'global_todo_done',
      description:
        '把一条全局待办标为完成（或标回未完成 / 进行中）。'
        + '如果复open是因为**原来标错了**，请用 `global_todo_reopen`：那条路径只做复open，'
        + '并会拒绝本来就未完成的条目。'
        + '标为完成时**务必带上 `summary`**（一句话说明你做了什么、结论是什么），'
        + '以及 `artifacts`（这次产出的文件路径或相关网址）——'
        + '清单上留下的完成记录就是这个，缺了它「已完成」等于什么都没说。'
        + '（交付给会话的待办即使你忘了调用，宿主也会在这一轮干净结束时自动收尾，'
        + '但那样只有最后一段回复和改动文件，不如你主动写清楚。）',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: [...STATUSES], description: '缺省 done' },
          summary: { type: 'string', description: '完成说明：做了什么、结果如何（标为 done 时必填）' },
          artifacts: {
            type: 'array',
            description: '产出或相关文档：本地绝对路径写 { kind: "file", value: "/abs/path" }，网页写 { kind: "url", value: "https://…" }',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['url', 'file'] },
                value: { type: 'string' },
                title: { type: 'string' },
              },
              required: ['value'],
              additionalProperties: false,
            },
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, todo: TODO_SHAPE, reason: { type: 'string' }, error: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) => {
          if (value.ok !== true) return text(`状态没改成功：${value.error ?? value.reason ?? '未知原因'}`)
          const lines = [`已更新状态：${value.todo.status}`, todoLine(value.todo)]
          const completion = value.todo.completion
          if (completion !== null && completion !== undefined) {
            lines.push('', `完成于 ${new Date(completion.at).toISOString()}（${completion.by}）`)
            if (completion.summary !== '') lines.push(completion.summary)
            if (completion.artifacts.length > 0) {
              lines.push('产出：')
              for (const link of completion.artifacts) lines.push(`- [${link.kind}] ${link.title} — ${link.value}`)
            }
          }
          return text(lines.join('\n'))
        },
      },
      async execute(args) {
        const status = args?.status ?? 'done'
        const outcome = await attempt(async () => {
          if (status !== 'done') return service.setStatus(args?.id, status, { by: 'agent' })
          const evidence = { summary: args?.summary ?? '', artifacts: args?.artifacts ?? [] }
          if (evidence.summary === '' && evidence.artifacts.length === 0) {
            return service.setStatus(args?.id, 'done', { by: 'agent' })
          }
          const { todo } = await service.complete(args?.id, evidence, { by: 'agent' })
          return todo
        })
        if (outcome.ok !== true) return outcome
        return { ok: true, todo: presentTodo(outcome.value, now()) }
      },
    },

    {
      name: 'global_todo_reopen',
      description:
        '把一条**被误标为完成**的全局待办标回未完成——只做 done / cancelled → open 这一件事。'
        + '修数据时用它：完成是错的，而这个动作会以 **agent** 的身份写进这条待办的活动轨迹'
        + '（谁、什么时候、为什么），不用再靠进展记录口头声明「其实是我干的」。'
        + '它**拒绝**本来就未完成的条目（那说明前提不成立，不该悄悄算成功）；'
        + '要标「进行中」或标完成，用 global_todo_done；改别的字段用 global_todo_update。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: '为什么标回来（可选，会写进活动轨迹的说明）' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, todo: TODO_SHAPE, reason: { type: 'string' }, error: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) => {
          if (value.ok !== true) return text('没有标回来：' + (value.error ?? value.reason ?? '未知原因'))
          return text('已标回未完成：\n' + todoLine(value.todo))
        },
      },
      async execute(args) {
        const outcome = await attempt(() => service.reopen(args?.id, { by: 'agent', reason: args?.reason }))
        if (outcome.ok !== true) return outcome
        return { ok: true, todo: presentTodo(outcome.value, now()) }
      },
    },

    {
      name: 'global_todo_remove',
      description: '永久删除一条全局待办。做完的事请用 global_todo_done 留痕，不要删。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, title: { type: 'string' }, reason: { type: 'string' }, error: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) =>
          value.ok === true
            ? text(`已删除：${value.title}`)
            : text(`没删掉：${value.error ?? value.reason ?? '未知原因'}`),
      },
      async execute(args) {
        const outcome = await attempt(() => service.remove(args?.id, { by: 'agent' }))
        if (outcome.ok !== true) return outcome
        return { ok: true, title: outcome.value.title }
      },
    },
  ]

  // One wrapper covers every tool. A counter written inside each tool would be
  // forgotten by the next one, and a call the model made has to be visible even
  // when it came back `{ ok: false }` — that is the call worth counting.
  if (metrics === undefined) return definitions
  return definitions.map((definition) => ({
    ...definition,
    async execute(args, exec) {
      try {
        const value = await definition.execute(args, exec)
        metrics.recordTool?.(definition.name, value?.ok !== false)
        return value
      } catch (error) {
        metrics.recordTool?.(definition.name, false)
        throw error
      }
    },
  }))
}
