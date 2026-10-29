/**
 * Bundle contract tests.
 *
 * The browser half cannot run under `node --test`, but the properties that
 * break silently in the GUI are checkable here:
 *
 *  1. the bundle is a classic script registering a factory under the package id,
 *     with no imports and no side effects outside `apply`;
 *  2. it registers the slots that make the sidebar entry open its panel;
 *  3. mounting that panel runs its effects without throwing — the failure mode
 *     that made the panel blank in a real host, because the shell retires a
 *     slot entry whose component crashes;
 *  4. it only uses theme tokens that exist;
 *  5. every route it calls exists on the host.
 *
 * A tiny hook runtime stands in for React, so `mount` really executes the
 * components and their effects. It carries no dependency, so it also runs in CI.
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8')
}

const manifest = JSON.parse(await read('package.json'))
const source = await read('lib/client.js')

/** Minimal React stand-in for the tests that only register slots, never render. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (callback) => callback,
  Component: class {},
}

/**
 * A tiny hook runtime: expands function and class components, keeps one hook
 * array per component type, and returns the collected effects so a test can run
 * them. Effects are where the browser-only failures live, and a plain render
 * never executes them.
 */
function createRuntime() {
  const stores = new Map()
  const classTypes = []
  let hooks = []
  let cursor = 0

  class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
  }

  const React = {
    Component,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++
      // Capture the owning store: the setter runs later, when the shared
      // `hooks` cursor points at a different component.
      const store = hooks
      if (store[index] === undefined) {
        store[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      return [
        store[index].value,
        (next) => {
          store[index].value = typeof next === 'function' ? next(store[index].value) : next
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: { current: initial } }
      return hooks[index].value
    },
    useCallback(callback) {
      return callback
    },
    useMemo(factory) {
      return factory()
    },
    useEffect(effect) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { effect }
    },
  }

  /**
   * Expand one element in place, keeping the tree linked so callers can walk
   * the rendered result, and collect every effect body encountered.
   *
   * @param {object} element
   * @param {Function[]} effects
   */
  function expand(element, effects) {
    if (element === null || element === undefined || typeof element !== 'object') return element
    // Children arrive as arrays; an array node has no `type`, so it must be
    // descended into explicitly or its component children never render.
    if (Array.isArray(element)) return element.map((child) => expand(child, effects))
    const { type, props, children } = element
    if (type !== undefined && type.prototype instanceof Component) {
      // Class components are functions too, so they are matched first.
      classTypes.push(type)
      const instance = new type(props)
      element.children = [expand(instance.render(), effects)]
      return element
    }
    if (typeof type === 'function') {
      let store = stores.get(type)
      if (store === undefined) {
        store = []
        stores.set(type, store)
      }
      const outerHooks = hooks
      const outerCursor = cursor
      hooks = store
      cursor = 0
      let rendered
      try {
        rendered = type({ ...props, children })
      } finally {
        hooks = outerHooks
        cursor = outerCursor
      }
      element.children = [expand(rendered, effects)]
      for (const hook of store) if (hook?.effect !== undefined) effects.push(hook.effect)
      return element
    }
    if (Array.isArray(children)) {
      element.children = children.map((child) => expand(child, effects))
    }
    return element
  }

  return {
    React,
    classTypes,
    /** @returns {{ tree: object, effects: Function[], classTypes: Function[] }} */
    mount(component, props) {
      const effects = []
      const tree = expand({ type: component, props: props ?? {}, children: [] }, effects)
      return { tree, effects, classTypes }
    },
  }
}

/** @returns {string[]} every string in a rendered tree */
function textsOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node === 'object') textsOf(node.children ?? [], out)
  return out
}

/** @returns {string[]} every className in a rendered tree */
function classesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) classesOf(child, out)
    return out
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  classesOf(node.children ?? [], out)
  return out
}

/**
 * A locale service written the way the real one is: every method touches
 * `this`, so a detached call throws exactly as the host's does.
 */
function methodOnlyLocale(localeId = 'zh-CN') {
  return {
    listeners: new Set(),
    register() {
      return () => {}
    },
    getLocale() {
      return { locale: localeId }
    },
    subscribe(fn) {
      this.listeners.add(fn)
      return () => this.listeners.delete(fn)
    },
  }
}

/**
 * Execute the bundle in a captured "browser".
 *
 * @param {object} [documentStub]
 * @returns {{ id: string, factory: Function }}
 */
function loadBundle(documentStub) {
  let entry = null
  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        entry = registration
      },
    },
  }
  const run = new Function('window', 'document', 'navigator', source) // eslint-disable-line no-new-func
  run(windowStub, documentStub, { language: 'zh-CN' })
  assert.ok(entry !== null, 'the bundle must register itself with window.__ModuleLoader__')
  return entry
}

/** A document double that records the stylesheet tags the bundle manages. */
function fakeDocument() {
  const tags = []
  return {
    tags,
    querySelectorAll(selector) {
      if (!selector.includes('data-plugin-css')) return []
      return tags.filter((tag) => tag.attrs['data-plugin-css'] !== undefined)
    },
    createElement() {
      return {
        attrs: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) {
          this.attrs[name] = value
        },
      }
    },
    head: {
      appendChild(tag) {
        tag.parentNode = {
          removeChild() {
            const index = tags.indexOf(tag)
            if (index >= 0) tags.splice(index, 1)
          },
        }
        tags.push(tag)
      },
    },
  }
}

/**
 * Mount the plugin's client half against a recording context.
 *
 * @param {Function} ReactImpl
 * @returns {{ registered: Map<string, {options: object, component: Function}>, effects: string[] }}
 */
function mountPlugin(ReactImpl) {
  const entry = loadBundle()
  const plugin = entry.factory((name) => (name === 'react' ? ReactImpl : undefined))
  const registered = new Map()
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: methodOnlyLocale(),
    slots: {
      inject(_name, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registered.set(options.name, { options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { registered, effects }
}

test('the bundle registers itself under the package name', () => {
  const entry = loadBundle()
  assert.equal(entry.id, manifest.name)
  assert.equal(typeof entry.factory, 'function')
})

test('the bundle is a classic script: no module syntax, no stray imports', () => {
  assert.doesNotMatch(source, /^\s*import\s/m, 'the client half is not an ES module')
  assert.doesNotMatch(source, /^\s*export\s/m, 'the client half must not export')
  // The only module request is the frozen platform table's `react`.
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
})

test('the factory returns a mountable plugin declaring its services', () => {
  const entry = loadBundle()
  const plugin = entry.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected module request: ${name}`)
  })
  // The declared dependencies are load-bearing: client services reach a plugin
  // through `inject` (the shipped panels declare the same list), and a service
  // that is used but not declared is exactly how the hand-off picker rendered
  // empty and the receipt's jump button did nothing.
  // `workspaces` used to be declared here and never read; a declared-but-unused
  // service makes the panel harder to mount in a lean client composition.
  assert.deepEqual(plugin.inject, ['sessions', 'uiWorkspace', 'slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the dictionary, the stylesheet and both slots', () => {
  const { registered, effects } = mountPlugin(reactStub)
  assert.ok(effects.some((label) => /dictionaries/.test(label)))
  assert.ok(effects.some((label) => /styles/.test(label)))

  const sidebar = registered.get('sidebar.panellist')
  const main = registered.get('main')
  assert.ok(sidebar !== undefined, 'the sidebar entry must be registered')
  assert.ok(main !== undefined, 'the main panel must be registered')
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(typeof main.component, 'function')
  assert.equal(sidebar.options.id, main.options.key, 'the sidebar id and the panel key must match')
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(sidebar.options.label(), '待办')
})

test('the main panel mounts and runs its effects against method-only services', () => {
  // Regression: `ctx.locale.subscribe` touches `this.listeners`, so extracting
  // it into a local variable threw inside an effect. The shell retires a
  // crashing slot entry, so the panel went blank — and stayed blank.
  const runtime = createRuntime()
  const { registered } = mountPlugin(runtime.React)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      data: { todos: [], counts: { total: 0, open: 0, doing: 0, done: 0, cancelled: 0, overdue: 0 } },
    }),
  })
  const disposers = []
  try {
    const { tree, effects } = runtime.mount(registered.get('main').component, {})
    for (const effect of effects) {
      assert.doesNotThrow(() => {
        const dispose = effect()
        if (typeof dispose === 'function') disposers.push(dispose)
      }, 'an effect must not throw while the panel mounts')
    }
    const texts = textsOf(tree).join(' ')
    assert.match(texts, /全局待办/)
    assert.ok(classesOf(tree).includes('gt-root'), 'the panel root must render')
  } finally {
    // The panel polls while it is mounted; leave no timer behind.
    for (const dispose of disposers) dispose()
    globalThis.fetch = originalFetch
  }
})

test('a panel crash is contained and reported instead of blanking the entry', () => {
  const runtime = createRuntime()
  const { registered } = mountPlugin(runtime.React)

  // Mounting the wrapper is what captures the boundary class it renders.
  runtime.mount(registered.get('main').component, {})
  const Boundary = runtime.classTypes.at(-1)
  assert.equal(typeof Boundary, 'function', 'the locale wrapper must render an error boundary')

  const healthy = new Boundary({ component: () => null, componentProps: {} })
  assert.equal(textsOf(healthy.render()).length, 0, 'no error means no fallback')

  healthy.state = Boundary.getDerivedStateFromError(new Error('boom'))
  const texts = textsOf(healthy.render()).join(' ')
  assert.match(texts, /面板出错了/)
  assert.match(texts, /boom/)
  assert.equal(typeof healthy.retry, 'function', 'the fallback must offer a retry')
})

test('a hot reload replaces the previous stylesheet instead of reusing it', () => {
  // The module is swapped in place on hot reload; the old <style> tag is not.
  // Reusing it renders the new markup against old rules — new class names have no
  // styles at all — which reads as "the panel did not change".
  const documentStub = fakeDocument()
  const stale = { attrs: { 'data-plugin-css': 'global-todo' }, textContent: '.gt-root{color:red}', parentNode: null }
  documentStub.head.appendChild(stale)

  const entry = loadBundle(documentStub)
  const plugin = entry.factory((name) => (name === 'react' ? reactStub : undefined))
  const effects = []
  plugin.apply({
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    locale: methodOnlyLocale(),
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => () => {},
    },
  })

  assert.equal(documentStub.tags.includes(stale), false, 'the stale tag must be gone')
  assert.equal(documentStub.tags.length, 1, 'exactly the current stylesheet remains')
  const current = documentStub.tags[0]
  assert.match(current.attrs['data-plugin-css-rev'], /^ui\d+$/)
  assert.match(current.textContent, /\.gt-groups/, 'the current build\'s CSS must be installed')
  assert.doesNotMatch(current.textContent, /color:red/)
})

test('only theme tokens that exist are used', () => {
  const tokens = [...source.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1])
  assert.ok(tokens.length > 20, 'the panel is styled with tokens')
  for (const token of tokens) {
    assert.match(token, /^--dsw-(alias|specific)-/, `unknown token ${token}`)
  }
})

test('a surface token is never used as a text colour', () => {
  // The bug this guards: `.gt-btn-primary` painted its label with `--dsw-alias-bg-base`, the
  // *canvas* token. That reads as "the opposite of the background" in the default themes, and it
  // is exactly why it survived review — but a wallpaper theme sets the canvas transparent so the
  // picture shows through, and then the label is transparent too: the button keeps its white pill
  // and loses its word (reported with a screenshot on 2026-10-28). A surface token belongs in a
  // `background`/`border-color`; text uses a `label-*` token.
  const start = source.indexOf('const CSS = `')
  const css = source.slice(start, source.indexOf('`', start + 'const CSS = `'.length))
  const surfaces = ['--dsw-alias-bg-', '--dsw-alias-border-', '--dsw-alias-menu-', '--dsw-alias-scrollbar-', '--dsw-specific-menu']
  const offenders = []
  for (const match of css.matchAll(/(?:^|[;{\s])(color|fill|stroke)\s*:\s*var\(\s*(--[a-z0-9-]+)/g)) {
    const token = match[2]
    if (surfaces.some((prefix) => token.startsWith(prefix))) offenders.push(`${match[1]}: ${token}`)
  }
  assert.deepEqual(offenders, [], 'text colours must come from label-* / state-* tokens, not from surfaces')
})

test('no literal colors leak into the stylesheet', () => {
  // Slice to the end of the template literal, not to the first '.gt-root' inside it.
  // The old end index sat 14 characters into the CSS, so this guard never actually
  // looked at a single colour and every literal would have passed.
  const start = source.indexOf('const CSS = `')
  const css = source.slice(start, source.indexOf('`', start + 'const CSS = `'.length))
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'use theme tokens instead of hex colors')
  assert.doesNotMatch(css, /\brgba?\(/, 'use theme tokens instead of rgb()')
})

test('the two dictionaries cover the same keys, and English stays English', () => {
  const block = (marker) => {
    const start = source.indexOf(marker)
    return source.slice(start, source.indexOf('\n    }', start))
  }
  const keys = (marker) => [...block(marker).matchAll(/^ {6}'([^']+)':/gm)].map((match) => match[1])
  const zhKeys = [...new Set(keys('const zh = {'))]
  const enKeys = new Set(keys('const en = {'))
  // A missing key silently falls back to Chinese, which an English reader sees as a bug.
  assert.deepEqual(zhKeys.filter((key) => !enKeys.has(key)), [], 'every Chinese key has an English one')
  const enCjk = [...block('const en = {').matchAll(/^ {6}'([^']+)': '([^']*)'/gm)]
    .filter((match) => /[\u4e00-\u9fff]/.test(match[2]))
    .map((match) => match[1])
  assert.deepEqual(enCjk, [], 'no English value is actually Chinese')
})

test('the panel talks to the host over a document-relative path', () => {
  assert.match(source, /const API = 'api\/global-todo'/)
  assert.doesNotMatch(source, /const API = '\/api\//, 'a root-absolute fetch escapes the deployment prefix')
})

test('every route the client calls exists on the host', async () => {
  const { ROUTE_BASE, createRoutes } = await import('../lib/routes.js')
  const hostPaths = new Set(
    createRoutes({
      service: { list: async () => ({}), get: async () => ({}), describe: async () => ({}), stats: async () => ({}) },
      dispatcher: { capabilities: () => ({}), dispatch: async () => ({}) },
      version: 'test',
    }).map((route) => route.path.replace(`${ROUTE_BASE}/`, '')),
  )
  const called = new Set([...source.matchAll(/call\(\s*'([a-z]+)'/g)].map((match) => match[1]))
  assert.ok(called.size >= 6, 'the panel calls the API')
  for (const suffix of called) {
    assert.ok(hostPaths.has(suffix), `client calls /${suffix} but the host does not serve it`)
  }
  assert.equal(`/${source.match(/const API = '([^']+)'/)[1]}`, ROUTE_BASE)
})
