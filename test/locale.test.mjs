import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/**
 * Slice one dictionary literal out of the client source.
 *
 * Reading the object at runtime cannot detect the bug this file exists for: a duplicate
 * key is legal JavaScript, the last one silently wins, and by the time the module runs
 * the first definition is gone. So the source is read as text.
 *
 * @param {string} name
 * @returns {string[]} the key tokens, in source order
 */
function keysOf(name) {
  const start = source.indexOf(`    const ${name} = {`)
  assert.notEqual(start, -1, `the ${name} dictionary is gone`)
  const end = source.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, `the ${name} dictionary is not closed`)
  const body = source.slice(start, end)
  const keys = []
  for (const line of body.split('\n')) {
    const match = /^\s+'([^']+)':/.exec(line)
    if (match !== null) keys.push(match[1])
  }
  assert.ok(keys.length > 100, `${name} looks truncated (${keys.length} keys)`)
  return keys
}

/** Binary-search-free duplicate report: key → how many times it appears. */
function duplicates(keys) {
  const counts = new Map()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key)
}

test('no dictionary key is defined twice', () => {
  // This is the shape that shipped "more fields" on the overflow menu: two entries for
  // action.more, the second quietly replacing the first.
  assert.deepEqual(duplicates(keysOf('zh')), [], 'a duplicate key means the earlier one is dead code')
  assert.deepEqual(duplicates(keysOf('en')), [], 'a duplicate key means the earlier one is dead code')
})

test('both dictionaries carry the same keys', () => {
  const zh = new Set(keysOf('zh'))
  const en = new Set(keysOf('en'))
  const missingInEn = [...zh].filter((key) => !en.has(key))
  const missingInZh = [...en].filter((key) => !zh.has(key))
  assert.deepEqual(missingInEn, [], 'a key only in zh falls back to the key name in English')
  assert.deepEqual(missingInZh, [], 'a key only in en falls back to the key name in Chinese')
})

test('the English dictionary carries no full-width punctuation', () => {
  // A colon or bracket typed in Chinese punctuation renders in English copy as an extra
  // space: "Working directory ：". Such characters belong in the zh values only.
  const start = source.indexOf('    const en = {')
  const end = source.indexOf('\n    }\n', start)
  const body = source.slice(start, end)
  const offenders = []
  for (const line of body.split('\n')) {
    const match = /^\s+'([^']+)': '(.*)',$/.exec(line)
    if (match === null) continue
    if (/[：（）！？，。；、「」]/.test(match[2])) offenders.push(match[1])
  }
  assert.deepEqual(offenders, [], 'full-width punctuation in an English value')
})

test('every referenced key exists', () => {
  const zh = new Set(keysOf('zh'))
  const missing = new Set()
  // t('literal') and t(`template.${x}`) — only the literal form can be checked, and it is
  // the one that breaks silently: the panel renders the raw key instead of the sentence.
  for (const match of source.matchAll(/\bt\('([^']+)'/g)) {
    if (!zh.has(match[1])) missing.add(match[1])
  }
  assert.deepEqual([...missing], [], 'a literal t() key that is not in the dictionary')
})
