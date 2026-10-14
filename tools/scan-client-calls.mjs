/**
 * Find calls to functions the client never defined.
 *
 * One real failure class motivated this: a handler that ran after a **successful**
 * request and then called a function nobody had written (`void refresh()`). The write
 * landed, the panel still showed an error, and the preview harness could not see it —
 * an error caught inside a handler only appears on a real re-render.
 *
 * It is deliberately a shallow lexical scan, not a scope analyser: comments and string
 * literals are removed first, then every binding-ish shape this file uses (functions,
 * declarations, destructuring, parameters, method shorthand) counts as defined. A name
 * called with `(` that is defined nowhere is reported.
 *
 * @param {string} source
 * @returns {string[]} undefined names, sorted, without duplicates
 */

const GLOBALS = new Set([
  'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'JSON', 'String', 'Number', 'Boolean',
  'Array', 'Object', 'Date', 'Error', 'TypeError', 'Math', 'Map', 'Set', 'WeakMap', 'Promise',
  'URLSearchParams', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'console', 'require', 'Symbol', 'Reflect', 'Proxy', 'BigInt',
])

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'void',
  'in', 'of', 'do', 'else', 'try', 'delete', 'yield', 'super', 'this', 'case', 'throw', 'instanceof',
])

/**
 * Remove comments and string literals, keeping the code around them.
 *
 * Prose is otherwise indistinguishable from identifiers, and this file is mostly prose.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripCommentsAndStrings(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1
        index += 1
      }
      index += 1
      out += ' '
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * @param {string} source
 * @returns {string[]}
 */
export function auditClientCalls(source) {
  const code = stripCommentsAndStrings(source)
  const defined = new Set(GLOBALS)

  const add = (name) => {
    if (typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
  }

  for (const match of code.matchAll(/(?:^|[\s(,{])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(match[1])
  for (const match of code.matchAll(/(?:^|[\s(,{])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(match[1])
  for (const match of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) add(match[1])
  // `const [a, setB] = ...` and `const { c, d: e } = ...`
  for (const match of code.matchAll(/(?:const|let|var)\s*[[{]([^\]}]*)[\]}]\s*=/g)) {
    for (const part of match[1].split(',')) add(part.split(':').pop().trim().replace(/^\.\.\./, ''))
  }
  // Method shorthand and parameters: `name(args) {`, `name: (args) =>`, `function (a, b)`.
  for (const match of code.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?:\{|=>)/gm)) {
    add(match[1])
    for (const part of match[2].split(',')) {
      add(part.split('=')[0].replace(/[{}\[\]]/g, '').trim())
    }
  }
  // Bare parameter lists of arrow functions without a name.
  for (const match of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of match[1].split(',')) add(part.split('=')[0].trim())
  }
  // Simple assignments create bindings too (`x = ...` at statement level).
  for (const match of code.matchAll(/(?:^|[\s(,{])([A-Za-z_$][\w$]*)\s*=[^=>]/g)) add(match[1])

  const problems = new Set()
  for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (defined.has(name) || KEYWORDS.has(name)) continue
    problems.add(name)
  }
  return [...problems].sort()
}
