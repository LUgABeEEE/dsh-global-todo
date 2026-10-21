/**
 * Markdown, both ways.
 *
 * The JSON export is the round-trip format; this one is for humans and for repositories:
 * it diffs line by line, it renders on GitHub, and it survives being edited by hand.
 *
 * The shape is deliberately plain — a task list with indented metadata — so that reading
 * it needs no documentation and writing it needs no schema:
 *
 *   - [ ] 标题
 *         优先级: 高 · 截止: 2026-10-21T18:00 · 标签: 发布, 文档
 *         描述: 第一行
 *         - [x] 一步
 *
 * Import is tolerant: unknown lines are ignored, a bad date is dropped instead of failing
 * the whole file, and anything that is not a task line simply does not become a todo.
 */

const PRIORITY_LABELS = { urgent: '紧急', high: '高', normal: '常规', low: '低' }
const PRIORITY_BY_LABEL = new Map(Object.entries(PRIORITY_LABELS).map(([key, label]) => [label, key]))
const STATUS_HEADINGS = [
  ['active', '未完成'],
  ['done', '已完成'],
  ['archived', '已归档'],
]

/** @param {string} text @returns {string} */
function clean(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/**
 * @param {{ todos: object[] }} doc
 * @param {{ now?: number, title?: string }} [options]
 * @returns {string}
 */
export function toMarkdown(doc, options = {}) {
  const todos = Array.isArray(doc?.todos) ? doc.todos : []
  const now = options.now ?? Date.now()
  const lines = [
    '# ' + (options.title ?? '全局待办'),
    '',
    '> 导出时间 ' + new Date(now).toISOString() + '，共 ' + todos.length + ' 条。',
    '',
  ]
  for (const [status, heading] of STATUS_HEADINGS) {
    const group = todos.filter((todo) => {
      const resolved = todo.status === 'done' ? 'done' : todo.status === 'archived' ? 'archived' : 'active'
      return resolved === status
    })
    if (group.length === 0) continue
    lines.push('## ' + heading, '')
    for (const todo of group) {
      lines.push('- [' + (todo.status === 'done' ? 'x' : ' ') + '] ' + todo.title)
      const meta = []
      if (todo.priority !== 'normal') meta.push('优先级: ' + (PRIORITY_LABELS[todo.priority] ?? todo.priority))
      if (todo.dueAt !== null && todo.dueAt !== undefined) meta.push('截止: ' + todo.dueAt)
      if (Array.isArray(todo.tags) && todo.tags.length > 0) meta.push('标签: ' + todo.tags.join(', '))
      if (todo.seq > 0) meta.push('#: ' + todo.seq)
      if (meta.length > 0) lines.push('      ' + meta.join(' · '))
      if (todo.evidence) lines.push('      原话: ' + todo.evidence)
      if (todo.description) {
        for (const line of clean(todo.description).split('\n')) lines.push('      描述: ' + line)
      }
      for (const step of todo.steps ?? []) lines.push('      - [' + (step.done === true ? 'x' : ' ') + '] ' + step.text)
      for (const link of todo.links ?? []) lines.push('      附件: ' + link.value)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * Read back what {@link toMarkdown} wrote, tolerantly.
 *
 * @param {string} text
 * @returns {{ todos: object[] }} the same document shape `/import` accepts
 */
export function fromMarkdown(text) {
  const todos = []
  let current = null
  // A file saved on Windows arrives with CRLF; split the same way everywhere instead of
  // leaving a trailing \r on every line for the matchers to trip over.
  const normalized = clean(text).replace(/\r\n?/g, '\n')
  for (const raw of normalized.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const task = /^- \[([ xX])\] (.+)$/.exec(line)
    if (task !== null) {
      current = {
        title: task[2].trim(),
        status: task[1].toLowerCase() === 'x' ? 'done' : 'open',
        description: '',
        priority: 'normal',
        tags: [],
        steps: [],
        links: [],
      }
      todos.push(current)
      continue
    }
    const step = /^\s+- \[([ xX])\] (.+)$/.exec(line)
    if (step !== null && current !== null) {
      current.steps.push({ text: step[2].trim(), done: step[1].toLowerCase() === 'x' })
      continue
    }
    const field = /^\s{2,}(优先级|截止|标签|描述|原话|附件|#): ?(.*)$/.exec(line)
    if (field === null || current === null) continue
    const [, key, value] = field
    if (key === '描述') {
      // Description lines are free text: they may contain ' · ' or anything else.
      current.description = current.description === '' ? value : current.description + '\n' + value
      continue
    }
    if (key === '原话') {
      current.evidence = value
      continue
    }
    if (key === '附件') {
      current.links.push(value.trim())
      continue
    }
    // One meta line packs several fields ('优先级: 高 · 截止: … · 标签: …'): split it back
    // into segments before reading any of them.
    for (const segment of (key + ': ' + value).split(' · ')) {
      const one = /^(优先级|截止|标签|#): ?(.*)$/.exec(segment)
      if (one === null) continue
      const [, name, raw] = one
      if (name === '优先级') current.priority = PRIORITY_BY_LABEL.get(raw.trim()) ?? 'normal'
      else if (name === '标签') current.tags = raw.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
      else if (name === '#') current.seq = Number.parseInt(raw, 10) || 0
      else if (name === '截止') {
        // A date that does not parse is dropped: one bad line must not fail the file.
        if (!Number.isNaN(Date.parse(raw))) current.dueAt = new Date(raw).toISOString()
      }
    }
  }
  return { todos }
}
