import test from 'node:test'
import assert from 'node:assert/strict'
import { atomicWrite } from '../lib/store.js'
import { normalizeSettings } from '../lib/settings.js'
import { fromMarkdown } from '../lib/markdown.js'
import { isAbsolutePath } from '../lib/links.js'

/** Fake fs that fails the first `failures` renames with `code`, then succeeds. */
function flakyRename({ failures = 0, code = 'EPERM' } = {}) {
  const calls = { rename: 0, unlink: [] }
  const fs = {
    async open() {
      return { async writeFile() {}, async sync() {}, async close() {} }
    },
    async rename() {
      calls.rename += 1
      if (calls.rename <= failures) throw Object.assign(new Error(code), { code })
    },
    async unlink(target) {
      calls.unlink.push(target)
    },
  }
  return { fs, calls }
}

test('a transient lock on the target is retried, not reported as a failed save', async () => {
  const { fs, calls } = flakyRename({ failures: 2, code: 'EPERM' })
  await atomicWrite('/tmp/store/todos.json', '{}', { fs })
  assert.equal(calls.rename, 3, 'two EPERM then success')
  assert.deepEqual(calls.unlink, [])
})

test('an error that is not a transient lock fails immediately', async () => {
  const { fs, calls } = flakyRename({ failures: 1, code: 'EXDEV' })
  await assert.rejects(() => atomicWrite('/tmp/store/todos.json', '{}', { fs }), /EXDEV/)
  assert.equal(calls.rename, 1, 'no pointless retries for a real error')
  assert.equal(calls.unlink.length, 1, 'debris is cleaned up')
})

test('a lock that never clears still fails, and leaves no temp file behind', async () => {
  const { fs, calls } = flakyRename({ failures: 99, code: 'EBUSY' })
  await assert.rejects(() => atomicWrite('/tmp/store/todos.json', '{}', { fs }), /EBUSY/)
  assert.equal(calls.rename, 5, 'the retry budget is bounded')
  assert.equal(calls.unlink.length, 1)
})

test('Windows absolute paths are accepted as workspace exemptions', () => {
  const settings = normalizeSettings({
    exemptWorkspaces: ['C:\\dev\\demo\\', '\\\\server\\share', '/home/me/ws', 'relative/path', ''],
  })
  assert.ok(settings.exemptWorkspaces.includes('C:\\dev\\demo'), 'drive path keeps its separators, trailing one dropped')
  assert.ok(settings.exemptWorkspaces.includes('\\\\server\\share'), 'UNC share is a place too')
  assert.ok(settings.exemptWorkspaces.includes('/home/me/ws'))
  assert.equal(settings.exemptWorkspaces.includes('relative/path'), false, 'a relative path is not an exemption')
})

test('a drive path and a UNC path are both "absolute" everywhere', () => {
  for (const value of ['/home/me/x', 'C:\\dev\\x', 'C:/dev/x', '\\\\server\\share\\x']) {
    assert.equal(isAbsolutePath(value), true, value)
  }
  for (const value of ['relative/path', './x', '..\\up', '']) {
    assert.equal(isAbsolutePath(value), false, value)
  }
})

test('markdown written on Windows (CRLF) parses exactly like LF', () => {
  const text = [
    '# 待办',
    '',
    '- [ ] 把周报模板换成新的四段式',
    '      优先级: 高 · 标签: 周报, 写作',
    '      描述: 第一段',
    '      描述: 第二段',
    '      - [x] 对齐字段',
    '',
  ].join('\r\n')
  const parsed = fromMarkdown(text)
  assert.equal(parsed.todos.length, 1)
  const todo = parsed.todos[0]
  assert.equal(todo.title, '把周报模板换成新的四段式')
  assert.equal(todo.priority, 'high')
  assert.deepEqual(todo.tags, ['周报', '写作'])
  assert.match(todo.description, /第一段[\s\S]*第二段/)
  assert.deepEqual(todo.steps, [{ text: '对齐字段', done: true }])
})
