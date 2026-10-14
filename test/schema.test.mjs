/**
 * Tool schema contract.
 *
 * The Host does not accept arbitrary JSON Schema: a tool whose schema falls
 * outside its subset is **rejected at registration**, and because registration
 * happens inside an effect the failure is quiet — the panel keeps working, the
 * model simply has no tools. That is exactly what happened in a real host, and
 * the reason this file exists.
 *
 * The subset mirrors `@deepseek-ai/dsh-tools`' validator:
 *
 *   - keywords: type / oneOf / properties / required / additionalProperties /
 *     items / enum / const, plus annotations (description, title, default,
 *     examples, deprecated, readOnly, writeOnly, $comment);
 *   - `type` must be a **single type string** — `type: ['string', 'null']` is
 *     the mistake this test was written for; nullability is `oneOf`;
 *   - `type` and `oneOf` are mutually exclusive, and a node using `oneOf` may
 *     carry no other constraint keyword;
 *   - `properties` / `required` / `additionalProperties` require `type: object`,
 *     `items` requires `type: array`, and `enum` / `const` require a primitive
 *     type whose values match.
 *
 * `scripts/check.mjs` additionally runs the Host's own validator when a DSH
 * profile is available, so a dev machine checks the real thing.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']
const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ANNOTATION_KEYWORDS = [
  'description',
  'title',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
]
const ONE_OF_SIBLINGS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const REQUIRES_OBJECT = ['properties', 'required', 'additionalProperties']
const PRIMITIVE_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

/**
 * @param {unknown} value
 * @param {string} type
 * @returns {boolean} whether a literal matches a declared JSON type
 */
function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  return typeof value === type
}

/**
 * Walk one schema and collect every violation of the Host's subset.
 *
 * @param {unknown} node
 * @param {string} path
 * @param {string[]} out
 */
function collect(node, path, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return
  }
  const keys = Object.keys(node)
  for (const key of keys) {
    if (!CONSTRAINT_KEYWORDS.includes(key) && !ANNOTATION_KEYWORDS.includes(key)) {
      out.push(`${path}.${key} is not a supported keyword`)
    }
  }
  if (typeof node.description === 'string' === false && node.description !== undefined) {
    out.push(`${path}.description must be a string`)
  }

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    out.push(`${path} cannot declare both type and oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} requires type or oneOf`)
    }
    return
  }

  if (hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key) && key !== 'type') out.push(`${path}.${key} is not supported beside oneOf`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      out.push(`${path}.oneOf must hold at least two schemas`)
      return
    }
    node.oneOf.forEach((branch, index) => collect(branch, `${path}.oneOf[${index}]`, out))
    return
  }

  const type = node.type
  if (typeof type !== 'string') {
    out.push(
      Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`,
    )
    return
  }
  if (!SCHEMA_TYPES.includes(type)) {
    out.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }

  for (const key of REQUIRES_OBJECT) {
    if (Object.hasOwn(node, key) && type !== 'object') out.push(`${path}.${key} requires type "object"`)
  }
  if (Object.hasOwn(node, 'items') && type !== 'array') out.push(`${path}.items requires type "array"`)
  for (const key of ['enum', 'const']) {
    if (Object.hasOwn(node, key) && !PRIMITIVE_TYPES.includes(type)) {
      out.push(`${path}.${key} requires a primitive type`)
    }
  }

  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) out.push(`${path}.enum must not be empty`)
    for (const value of node.enum) {
      if (PRIMITIVE_TYPES.includes(type) && !matchesType(value, type)) {
        out.push(`${path}.enum holds ${JSON.stringify(value)}, which is not a ${type}`)
      }
    }
  }
  if (Object.hasOwn(node, 'const') && PRIMITIVE_TYPES.includes(type) && !matchesType(node.const, type)) {
    out.push(`${path}.const does not match type ${type}`)
  }

  if (type === 'object' && node.properties !== undefined) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      out.push(`${path}.properties must be an object`)
    } else {
      for (const [name, child] of Object.entries(node.properties)) {
        collect(child, `${path}.properties.${name}`, out)
      }
    }
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) out.push(`${path}.required must be an array`)
    else {
      const known = node.properties === undefined ? [] : Object.keys(node.properties)
      for (const name of node.required) {
        if (!known.includes(name)) out.push(`${path}.required names an undeclared property: ${name}`)
      }
    }
  }
  if (type === 'array' && node.items !== undefined) collect(node.items, `${path}.items`, out)
}

/** @returns {string[]} */
function violationsOf(schema) {
  const out = []
  collect(schema, 'schema', out)
  return out
}

function toolsOf() {
  const store = createStore({ file: '/tmp/gt-schema-contract/todos.json' })
  return createTools(createService({ store, config: { requireExistingFiles: false } }))
}

test('every tool schema stays inside the Host subset', () => {
  for (const tool of toolsOf()) {
    for (const [label, schema] of [
      ['parameters', tool.parameters],
      ['output.schema', tool.output.schema],
    ]) {
      const violations = violationsOf(schema)
      assert.deepEqual(violations, [], `${tool.name}.${label}: ${violations.join(' | ')}`)
    }
  }
})

test('the nullability mistake this contract exists for is actually detected', () => {
  // Guards the guard: if the walker stops recognising a type array, the test
  // above would pass while the Host keeps rejecting our schemas.
  const violations = violationsOf({ type: 'object', properties: { dueAt: { type: ['string', 'null'] } } })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /type arrays are not supported/)

  assert.match(violationsOf({ type: ['string'], oneOf: [{ type: 'string' }] })[0], /cannot declare both type and oneOf/)
  assert.match(violationsOf({ properties: {} })[0], /requires type or oneOf/)
  assert.match(violationsOf({ type: 'object', items: { type: 'string' } })[0], /items requires type "array"/)
  assert.match(violationsOf({ type: 'object', additionalProperties: true, patternProperties: {} })[0], /not a supported keyword/)
  assert.match(violationsOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] })[0], /undeclared property/)
  assert.deepEqual(violationsOf({ type: 'string', description: 'plain' }), [])
  assert.deepEqual(violationsOf({ oneOf: [{ type: 'string' }, { type: 'null' }], description: 'nullable' }), [])
})

test('nullability is expressed with oneOf, not a type array', () => {
  const update = toolsOf().find((tool) => tool.name === 'global_todo_update')
  assert.deepEqual(update.parameters.properties.dueAt.oneOf, [{ type: 'string' }, { type: 'null' }])
  const link = toolsOf().find((tool) => tool.name === 'global_todo_link')
  assert.ok(Array.isArray(link.parameters.properties.add.items.oneOf))
})
