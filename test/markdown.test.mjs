import { strict as assert } from 'node:assert'
import test from 'node:test'

import { fromMarkdown, toMarkdown } from '../lib/markdown.js'
import { weeklyReport } from '../lib/report.js'

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function todo(overrides) {
  return {
    id: 't-1',
    seq: 1,
    title: '发版',
    description: '',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    tags: [],
    steps: [],
    links: [],
    evidence: '',
    createdAt: NOW - 2 * DAY,
    doneAt: null,
    completion: null,
    review: null,
    ...overrides,
  }
}

test('markdown carries what the list carries, and reads it back', () => {
  const doc = {
    todos: [
      todo({
        title: '发版到 npm',
        priority: 'high',
        dueAt: '2026-10-21T10:00:00.000Z',
        tags: ['发布', '文档'],
        evidence: '「这个版本今天发」',
        description: '先对齐版本号\n再跑 verify',
        steps: [
          { text: '对齐版本号', done: true },
          { text: '跑 verify', done: false },
        ],
        links: [
          { kind: 'url', value: 'https://example.com/pr', title: 'PR' },
          { kind: 'file', value: '/tmp/plan.md', title: '方案' },
        ],
      }),
      todo({ id: 't-2', seq: 2, title: '补文档', status: 'done', doneAt: NOW - DAY }),
    ],
  }
  const markdown = toMarkdown(doc, { now: NOW })
  assert.match(markdown, /## 未完成/)
  assert.match(markdown, /## 已完成/)
  assert.match(markdown, /- \[ \] 发版到 npm/)
  assert.match(markdown, /- \[x\] 补文档/)
  assert.match(markdown, /- \[x\] 对齐版本号/)
  assert.match(markdown, /附件: \/tmp\/plan\.md/)

  const back = fromMarkdown(markdown)
  assert.equal(back.todos.length, 2)
  const first = back.todos[0]
  assert.equal(first.title, '发版到 npm')
  assert.equal(first.priority, 'high')
  assert.deepEqual(first.tags, ['发布', '文档'])
  assert.equal(first.evidence, '「这个版本今天发」')
  assert.equal(first.description, '先对齐版本号\n再跑 verify')
  assert.deepEqual(first.steps, [
    { text: '对齐版本号', done: true },
    { text: '跑 verify', done: false },
  ])
  assert.deepEqual(first.links, ['https://example.com/pr', '/tmp/plan.md'])
  assert.equal(back.todos[1].status, 'done', 'a ticked task comes back done')
})

test('a hand-edited file is read tolerantly', () => {
  const text = [
    '# 我的清单',
    '',
    '随便写点说明，不应该变成待办。',
    '- [ ] 第一条',
    '      优先级: 紧急 · 标签: 家, 电费',
    '      截止: 不是日期',
    '- [x] 第二条',
    '- [ ] ',
  ].join('\n')
  const { todos } = fromMarkdown(text)
  assert.equal(todos.length, 2, 'the empty task line is not a todo')
  assert.equal(todos[0].priority, 'urgent')
  assert.deepEqual(todos[0].tags, ['家', '电费'])
  assert.equal(todos[0].dueAt, undefined, 'an unreadable date is dropped, not fatal')
})

test('the weekly report counts what moved, and by whom', () => {
  const todos = [
    todo({
      id: 't-a',
      title: '装插件',
      status: 'done',
      doneAt: NOW - DAY,
      completion: {
        at: NOW - DAY,
        by: 'agent',
        summary: '装好了',
        sessionId: 'session-1',
        artifacts: [{ kind: 'file', value: '/repo/lib/a.js', title: 'a.js' }],
      },
    }),
    todo({
      id: 't-b',
      title: '改文档',
      status: 'done',
      doneAt: NOW - DAY,
      completion: {
        at: NOW - 2 * DAY,
        by: 'agent',
        summary: '改完了',
        sessionId: 'session-1',
        artifacts: [{ kind: 'file', value: '/repo/lib/a.js', title: 'a.js' }],
      },
      review: { pending: true, at: NOW - DAY, by: 'agent' },
    }),
    todo({ id: 't-c', title: '上周的事', status: 'done', completion: { at: NOW - 20 * DAY, by: 'agent', summary: '', sessionId: '', artifacts: [] } }),
    todo({ id: 't-d', title: '还没做' }),
  ]
  const report = weeklyReport(todos, { now: NOW, days: 7 })
  assert.equal(report.finished.length, 2, 'the 20-day-old completion is outside the window')
  assert.equal(report.sessions, 1)
  assert.equal(report.files[0].path, '/repo/lib/a.js')
  assert.equal(report.files[0].count, 2, 'the same file touched twice is one row with a count')
  assert.equal(report.pendingReview, 1)
  assert.equal(report.created, 4, 'every record in the window counts as created')
  // Newest first, so the page does not need to re-sort.
  assert.equal(report.finished[0].id, 't-a')
})
