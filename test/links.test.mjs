import { strict as assert } from 'node:assert'
import test from 'node:test'

import { TodoError } from '../lib/errors.js'
import { defaultLinkTitle, formatLink, inferLinkKind, isAbsolutePath, linkKey, normalizeLink } from '../lib/links.js'

test('a bare http(s) string is an address, anything else is a document', () => {
  assert.equal(inferLinkKind('https://example.com/doc'), 'url')
  assert.equal(inferLinkKind('http://example.com'), 'url')
  assert.equal(inferLinkKind('/home/me/notes/plan.md'), 'file')
  assert.equal(inferLinkKind('C:\\notes\\plan.md'), 'file')
})

test('URL attachments are canonicalised and titled from the host and path', () => {
  const link = normalizeLink('https://example.com/a/b?x=1')
  assert.equal(link.kind, 'url')
  assert.equal(link.value, 'https://example.com/a/b?x=1')
  assert.equal(link.title, 'example.com/a/b')
})

test('an explicit kind overrides inference', () => {
  const link = normalizeLink({ kind: 'file', value: '/tmp/README.md', title: '说明' })
  assert.deepEqual(link, { kind: 'file', value: '/tmp/README.md', title: '说明' })
})

test('document attachments default their title to the basename', () => {
  assert.equal(normalizeLink('/home/me/notes/plan.md').title, 'plan.md')
  assert.equal(normalizeLink('C:\\notes\\plan.md').title, 'plan.md')
})

test('URLs carrying credentials are refused', () => {
  // A credential in a URL would be persisted into the list, the audit trail
  // and every dispatch prompt.
  assert.throws(() => normalizeLink('https://user:secret@example.com/x'), TodoError)
  assert.throws(() => normalizeLink('https://token@example.com/x'), /不允许带用户名或密码/)
})

test('non-http protocols and empty values are refused', () => {
  assert.throws(() => normalizeLink({ kind: 'url', value: 'ftp://example.com' }), /只接受 http\/https/)
  assert.throws(() => normalizeLink({ kind: 'url', value: 'javascript:alert(1)' }), /只接受 http\/https/)
  assert.throws(() => normalizeLink(''), /不能为空/)
  assert.throws(() => normalizeLink('   '), /不能为空/)
  assert.throws(() => normalizeLink(42), /必须是字符串/)
})

test('document paths must be absolute', () => {
  assert.throws(() => normalizeLink('docs/plan.md'), /绝对路径/)
  assert.throws(() => normalizeLink('./plan.md'), /绝对路径/)
  assert.equal(isAbsolutePath('/a'), true)
  assert.equal(isAbsolutePath('C:/a'), true)
  assert.equal(isAbsolutePath('\\\\server\\share\\a'), true)
  assert.equal(isAbsolutePath('a/b'), false)
})

test('a missing document is only refused when the caller asks for existence', () => {
  const exists = (candidate) => candidate === '/exists.md'
  assert.throws(
    () => normalizeLink({ kind: 'file', value: '/missing.md' }, { requireExistingFiles: true, exists }),
    /找不到这个文件/,
  )
  const kept = normalizeLink({ kind: 'file', value: '/missing.md' }, { requireExistingFiles: false, exists })
  assert.equal(kept.value, '/missing.md')
})

test('titles are bounded', () => {
  assert.throws(() => normalizeLink({ kind: 'url', value: 'https://example.com', title: 'x'.repeat(201) }), /最多 200/)
})

test('link identity ignores the title', () => {
  assert.equal(linkKey({ kind: 'url', value: 'https://a' }), linkKey({ kind: 'url', value: 'https://a', title: 'A' }))
  assert.notEqual(linkKey({ kind: 'url', value: 'https://a' }), linkKey({ kind: 'file', value: 'https://a' }))
})

test('formatLink always has a title', () => {
  assert.equal(formatLink({ kind: 'url', value: 'https://example.com/docs' }), 'example.com/docs — https://example.com/docs')
  assert.equal(formatLink({ kind: 'file', value: '/a/b.md', title: '计划' }), '计划 — /a/b.md')
})

test('defaultLinkTitle tolerates odd input', () => {
  assert.equal(defaultLinkTitle('file', '/'), '/')
  assert.equal(defaultLinkTitle('url', 'not a url'), 'not a url')
})
