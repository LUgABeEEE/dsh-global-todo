import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { auditClientCalls, stripCommentsAndStrings } from '../tools/scan-client-calls.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the shipped client calls nothing it did not define', () => {
  const source = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
  assert.deepEqual(auditClientCalls(source), [], 'an undefined call must never ship')
})

test('the scan catches the failure it exists for', () => {
  // This is the shape that reached the user twice: the request succeeded, then the
  // handler called a function nobody had written, and the panel showed an error.
  const source = ['async function save() {', '  await send()', '  void refresh()', '}', 'function send() {}'].join('\n')
  assert.deepEqual(auditClientCalls(source), ['refresh'])
})

test('comments, strings, destructured setters and class methods are not false positives', () => {
  const source = [
    '// a note about refresh() and label()',
    "const TEXT = 'rotate(90deg) translateX(2px)'",
    'const React = { useState: () => [] }',
    'const { useState } = React',
    'function Panel() {',
    '  const [state, setState] = useState({})',
    '  const { open, close: shut } = props',
    '  const bump = () => setState({})',
    '  return { apply(ctx) { bump() }, opening: shut }',
    '}',
    'class Boundary { constructor(props) { super(props) } render() { return null } retry() {} }',
  ].join('\n')
  assert.deepEqual(auditClientCalls(source), [])
})

test('stripping keeps positions usable and removes prose', () => {
  const stripped = stripCommentsAndStrings('a() // b()\nc("d()")\n/* e() */')
  assert.match(stripped, /a\(\)/)
  assert.match(stripped, /c\(/)
  assert.doesNotMatch(stripped, /b\(\)/)
  assert.doesNotMatch(stripped, /e\(\)/)
})
