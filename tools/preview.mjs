/**
 * Panel preview.
 *
 * Renders the real client half into standalone HTML so the panel can be
 * inspected — and screenshotted — without a running Host or a logged-in GUI.
 * It reuses the same dependency-free hook runtime the bundle tests use: mounts
 * the panel, runs its effects against mock data, then serializes the result
 * next to a copy of the plugin's own stylesheet.
 *
 *   npm run preview                 # writes preview/panel.html + preview/panel-detail.html
 *   node tools/preview.mjs out.html # or wherever you want it
 *
 * The theme tokens in the preview harness are a dark-theme stand-in; the real
 * values come from the Host.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(root, 'lib', 'client.js')
// Flags are not paths: `--check` must not become the output file name.
const OUT_ARG = process.argv.slice(2).find((argument) => argument.startsWith('-') !== true)
const OUT = OUT_ARG === undefined ? path.join(root, 'preview', 'panel.html') : path.resolve(OUT_ARG)
const source = readFileSync(CLIENT, 'utf8')

const NOW = Date.now()
const HOUR = 3600 * 1000

const TODOS = [
  {
    id: 't-1a2b3c4d',
    title: '把dsh-global-todo发到 npm，并在 README 里补上截图',
    description: '先把版本号对齐 package.json 与 VERSION，再跑一遍 npm run verify。\n发布走 Trusted Publishing，不需要 token。',
    status: 'doing',
    priority: 'high',
    dueAt: new Date(NOW + 20 * HOUR).toISOString(),
    tags: ['发布', '文档'],
    notes: [
      { at: NOW - 2 * HOUR, by: 'agent', text: '版本号已对齐，verify 跑过了。' },
      { at: NOW - HOUR, by: 'agent', text: '卡在需要你在 npm 上绑定 Trusted Publisher，绑定后我打 tag 发布。' },
    ],
    links: [
      { kind: 'url', value: 'https://docs.npmjs.com/trusted-publishers', title: 'docs.npmjs.com/trusted-publishers' },
      { kind: 'file', value: '/home/me/projects/dsh-global-todo/docs/DESIGN.md', title: 'DESIGN.md' },
      { kind: 'file', value: '/home/me/projects/dsh-global-todo/docs/归档设计稿.md', title: '归档设计稿.md', missing: true },
    ],
    createdAt: NOW - 3 * HOUR,
    createdBy: 'human',
    updatedAt: NOW - 2 * HOUR,
    doneAt: null,
    sessionId: 'session-9f2c1e',
    sessionAlive: true,
    sessionDir: '/home/me/projects/dsh-global-todo',
    lastDispatch: { at: NOW - 2 * HOUR, mode: 'new', ok: true, sessionId: 'session-9f2c1e' },
  },
  {
    id: 't-5e6f7a8b',
    title: '等交换机到货后重测内网吞吐',
    description: '',
    status: 'open',
    priority: 'urgent',
    dueAt: new Date(NOW - 26 * HOUR).toISOString(),
    tags: [],
    links: [{ kind: 'url', value: 'https://github.com/example/dorm-network', title: 'github.com/example/dorm-network' }],
    createdAt: NOW - 30 * HOUR,
    createdBy: 'agent',
    updatedAt: NOW - 30 * HOUR,
    doneAt: null,
    sessionId: '',
    sessionAlive: false,
    sessionDir: '',
    originDir: '/home/me/projects/dorm-network',
    originSessionId: 'session-00000000-0000-4000-8000-000000000001',
    lastDispatch: null,
  },
  {
    id: 't-9c0d1e2f',
    title: '给 staging 迁移动手写一个回滚脚本',
    originSessionId: 'session-00000000-0000-4000-8000-000000000001',
    description: '先把现网 schema 导出成 SQL，再在 staging 上演练一次。',
    status: 'open',
    priority: 'low',
    dueAt: null,
    tags: ['运维'],
    links: [],
    createdAt: NOW - 2 * 24 * HOUR,
    createdBy: 'human',
    updatedAt: NOW - 2 * 24 * HOUR,
    doneAt: null,
    sessionId: '',
    sessionAlive: false,
    lastDispatch: null,
  },
  {
    id: 't-3a4b5c6d',
    originSessionId: 'session-55bb11ff-aaaa-bbbb-cccc-ddddeeeeffff',
    title: '把周报模板换成新的四段式',
    description: '',
    status: 'done',
    priority: 'normal',
    dueAt: null,
    tags: [],
    links: [],
    createdAt: NOW - 5 * 24 * HOUR,
    createdBy: 'agent',
    updatedAt: NOW - 4 * 24 * HOUR,
    doneAt: NOW - 4 * 24 * HOUR,
    notes: [{ at: NOW - 4 * 24 * HOUR, by: 'agent', text: '已按四段式重写并替换了旧模板。' }],
    completion: {
      at: NOW - 4 * 24 * HOUR,
      by: 'agent',
      summary: '把周报模板换成「进展 / 阻塞 / 下周 / 需要的支持」四段式，并在工作区里替换了旧模板。',
      sessionId: 'session-77aa31',
      artifacts: [{ kind: 'file', value: '/home/me/projects/dsh-notes/模板/周报.md', title: '周报.md' }],
    },
    sessionId: '',
    sessionAlive: false,
    lastDispatch: null,
  },
]

const COUNTS = { total: 4, open: 2, doing: 1, done: 1, cancelled: 0, overdue: 1 }

// ------------------------------------------------------------------ runtime

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
      // Capture the owning store: the setter may run long after expansion, when
      // the shared `hooks` cursor points at a different component.
      const store = hooks
      if (store[index] === undefined) store[index] = { value: typeof initial === 'function' ? initial() : initial }
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
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect(effect) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { effect }
    },
  }
  function expand(element, effects, path = '') {
    if (element === null || element === undefined || typeof element !== 'object') return element
    // Children arrive as arrays; an array node has no `type`, so it must be
    // descended into explicitly or its component children never render.
    if (Array.isArray(element)) return element.map((child, index) => expand(child, effects, `${path}/${index}`))
    const { type, props, children } = element
    if (type !== undefined && type.prototype instanceof Component) {
      classTypes.push(type)
      const instance = new type(props)
      element.children = [expand(instance.render(), effects, path)]
      return element
    }
    if (typeof type === 'function') {
      const key = `${path}#${type.name || 'anon'}`
      let store = stores.get(key)
      if (store === undefined) {
        store = []
        stores.set(key, store)
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
      element.children = [expand(rendered, effects, path)]
      for (const hook of store) if (hook?.effect !== undefined) effects.push(hook.effect)
      return element
    }
    if (Array.isArray(children)) element.children = children.map((child, index) => expand(child, effects, `${path}/${index}`))
    return element
  }
  return {
    React,
    mount(component, props) {
      const effects = []
      const tree = expand({ type: component, props: props ?? {}, children: [] }, effects)
      return { tree, effects }
    },
  }
}

// ------------------------------------------------------------------ html

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toHtml(node) {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (typeof node !== 'object') return ''
  const { type, props = {}, children } = node
  if (typeof type === 'function') return toHtml(children ?? [])
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false || key === 'children') continue
    if (key === 'key' || key === 'ref') continue
    if (key === 'style' && typeof value === 'object') {
      attrs.push(`style="${escapeHtml(Object.entries(value).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`).join(';'))}"`)
      continue
    }
    if (key === 'className') {
      attrs.push(`class="${escapeHtml(value)}"`)
      continue
    }
    if (typeof value === 'boolean') {
      if (value) attrs.push(key)
      continue
    }
    if (typeof value === 'function') continue
    attrs.push(`${key}="${escapeHtml(value)}"`)
  }
  const inner = toHtml(children ?? [])
  const open = `<${type}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
  return VOID_TAGS.has(type) ? open : `${open}${inner}</${type}>`
}

// ------------------------------------------------------------------ run

const runtime = createRuntime()

/**
 * The shell hands slot components a `useSessions` selector hook. The preview has
 * no shell, so it supplies a small stand-in — otherwise the hand-off picker would
 * render with no conversations to choose from and the screenshot would document
 * a feature nobody can see.
 */
const FAKE_SESSIONS = {
  byId: {
    'session-77aa31c0-1111-2222-3333-444455556666': {
      id: 'session-77aa31c0-1111-2222-3333-444455556666',
      title: 'dsh-global-todo · 设计与实现',
      cwd: '/home/me/projects/dsh-global-todo',
      retainedBy: { mainView: 1 },
    },
    'session-00000000-0000-4000-8000-000000000001': {
      id: 'session-00000000-0000-4000-8000-000000000001',
      title: 'Docker 与知识库',
      cwd: '/home/me',
    },
    'session-55bb11ff-aaaa-bbbb-cccc-ddddeeeeffff': {
      id: 'session-55bb11ff-aaaa-bbbb-cccc-ddddeeeeffff',
      title: 'dorm-network',
      cwd: '/home/me/projects/dorm-network',
    },
  },
}
const previewProps = {
  useSessions: (read) => read(FAKE_SESSIONS),
}
let entry = null
new Function('window', 'document', 'navigator', source)(
  { __ModuleLoader__: { load: (registration) => (entry = registration) } },
  undefined,
  { language: 'zh-CN' },
)
const plugin = entry.factory((name) => (name === 'react' ? runtime.React : undefined))

const registered = new Map()
plugin.apply({
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {}, subscribe: () => () => {}, getLocale: () => ({ locale: 'zh-CN' }) },
  // Hostile on purpose: the real shell's `inject` can throw, and a throw from an
  // effect is not a render error, so no error boundary catches it. An earlier
  // version called it unguarded and the panel went blank; this keeps that from
  // coming back.
  inject: () => {
    throw new Error('preview: no services are mounted here')
  },
  slots: {
    inject: (_name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registered.set(options.name, component)
      return () => {}
    },
  },
})

const requestedUrl = []
globalThis.fetch = async (url) => {
  requestedUrl.push(url)
  const payload = url.includes('/health')
    ? { ok: true, data: { plugin: 'dsh-global-todo', version: '0.1.0', store: { file: '/home/me/.dsh/global-todo/todos.json' }, dispatch: { agents: true } } }
    : { ok: true, data: { todos: TODOS, counts: COUNTS } }
  return { status: 200, json: async () => payload }
}

const first = runtime.mount(registered.get('main'), previewProps)
for (const effect of first.effects) effect()
await new Promise((resolve) => setTimeout(resolve, 20))
const second = runtime.mount(registered.get('main'), previewProps)

const css = source.slice(source.indexOf('const CSS = `') + 'const CSS = `'.length, source.indexOf('`\n\n    // ---'))

/** Find the first node matching a predicate, depth first. */
/** Collect every button matching `predicate`, depth-first, in render order. */
function collectButtonsBy(node, predicate, into) {
  if (node === null || node === undefined || typeof node !== 'object') return into
  if (Array.isArray(node)) {
    for (const child of node) collectButtonsBy(child, predicate, into)
    return into
  }
  if (node.type === 'button' && predicate(node) === true) into.push(node)
  return collectButtonsBy(node.children ?? [], predicate, into)
}

function findButtonBy(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButtonBy(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findButtonBy(node.children ?? [], predicate)
}

/** Find the first button whose label contains `label`. */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.type === 'button') {
    const text = []
    const collect = (child) => {
      if (child === null || child === undefined) return
      if (typeof child === 'string' || typeof child === 'number') text.push(String(child))
      else if (Array.isArray(child)) child.forEach(collect)
      else if (typeof child === 'object') collect(child.children ?? [])
    }
    collect(node.children)
    if (text.join(' ').includes(label)) return node
  }
  return findButton(node.children ?? [], label)
}

// Open the *last* row's menu: the groups render 逾期 → 接下来 → 没有截止时间 →
// 已完成, so the last one is the finished todo — the detail view that shows the
// completion record this preview exists to document.
const menuTriggers = []
collectButtonsBy(second.tree, (node) => node.props?.['aria-haspopup'] === 'menu', menuTriggers)
const menuTrigger = menuTriggers.length > 0 ? menuTriggers[menuTriggers.length - 1] : null
if (menuTrigger !== null) menuTrigger.props.onClick()
const withMenu = runtime.mount(registered.get('main'), previewProps)
const detailButton = findButton(withMenu.tree, '详情')
if (detailButton !== null && typeof detailButton.props?.onClick === 'function') detailButton.props.onClick()
const third = runtime.mount(registered.get('main'), previewProps)

const render = (tree) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>全局待办 · UI 预览</title>
<style>
  :root{
    --dsw-alias-bg-base:#0d1017; --dsw-alias-bg-layer-1:#151922; --dsw-alias-bg-layer-2:#1b2130;
    --dsw-alias-bg-overlay:#1b2130; --dsw-alias-border-l1:#262d3d; --dsw-alias-border-l2:#39425a;
    --dsw-alias-brand-primary:#6ea8ff; --dsw-alias-label-primary:#e7ebf3; --dsw-alias-label-secondary:#98a2b8;
    --dsw-alias-state-error-primary:#ff7b72; --dsw-alias-state-success-primary:#3ddc97;
    --dsw-alias-state-warn-primary:#ffcc66; --dsw-specific-sidebar-fill:#11151d;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .frame{max-width:920px;margin:0 auto;height:100vh;display:flex;flex-direction:column}
  .shellbar{display:flex;gap:8px;align-items:center;padding:10px 16px;color:var(--dsw-alias-label-secondary);
    font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
  .shellbar b{color:var(--dsw-alias-label-primary);font-weight:600}
  .main{flex:1;min-height:0;overflow:auto}
${css}
</style></head>
<body><div class="frame">
  <div class="shellbar"><b>DSH</b><span>·</span><span>侧栏「待办」→ 主面板（预览用外壳，非真实宿主）</span></div>
  <div class="main">${toHtml(tree)}</div>
</div></body></html>
`

const panelHtml = render(second.tree)
const detailHtml = render(third.tree)
mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true })
writeFileSync(OUT, panelHtml)
writeFileSync(OUT.replace(/\.html?$/, '') + '-detail.html', detailHtml)
console.log('written', OUT, 'and the detail variant; fetch calls:', requestedUrl.join(', '))

/**
 * Structural checks on the rendered panel.
 *
 * The client half has no unit-test seam — it is one classic script with no
 * exports — so the render itself is the only place these can be asserted. Run
 * with `--check` (which `npm run verify` does) to treat them as a test.
 *
 * @param {string} html
 * @returns {string[]} failures, empty when the render looks right
 */
function checkRenderedPanel(html, detail) {
  const failures = []
  const expect = (condition, message) => {
    if (condition !== true) failures.push(message)
  }

  // Every todo in the sample that came from the same conversation must be one
  // entry: the header line, and none of the rows it stands for.
  // The shell knows the conversation titles, so the merged group is named after
  // the conversation rather than after an id suffix.
  expect(html.includes('Docker 与知识库'), 'the merged conversation header is missing its title')
  expect(html.includes('2 条'), 'the merged header does not carry its count')
  // The group header carries the titles in its tooltip, which is fine — what
  // must not exist is a *row* for them.
  expect(!html.includes('gt-item-title">等交换机到货后重测内网吞吐'), 'a merged todo is still rendered as its own row')
  expect(!html.includes('gt-item-title">给 staging 迁移动手写一个回滚脚本'), 'a merged todo is still rendered as its own row')
  // Single-item conversations keep their row.
  expect(html.includes('把周报模板换成新的四段式'), 'a single-item conversation lost its row')
  // Levels are visible, and the switcher offers all three dimensions.
  expect(html.includes('data-level="high"'), 'no level badge was rendered')
  // The overdue sample is P0, and its conversation is collapsed — so the level has
  // to reach the group header, which is exactly what a careless fixture hid once.
  expect(html.includes('data-level="urgent"'), 'the P0 level badge is missing from the group header')
  // The live-session badge: the sample row is bound to a running conversation.
  expect(html.includes('gt-chip-ok'), 'the running-session badge lost its colour')
  expect(html.includes('会话在跑'), 'the running-session badge label is missing')
  expect(html.includes('P0 紧急'), 'the P0 label is missing')
  // Progress notes and dead attachments are user-facing facts, so they are asserted
  // rather than assumed to render. The row shows the count; the detail — which only
  // exists for the open row — carries the trail.
  expect(html.includes('2 条进展'), 'the row does not show how many notes there are')
  expect(html.includes('文件不在了'), 'a missing attachment is not flagged on the row')
  expect(html.includes('is:overdue'), 'the search syntax hint is missing')
  expect(detail.includes('进展记录'), 'the notes section is missing from the detail')
  expect(detail.includes('已按四段式重写'), 'a note body is missing from the detail')
  // The hand-off picker must offer real conversations, not only fallbacks.
  expect(html.includes('dsh-global-todo · 设计与实现'), 'the hand-off picker lost its conversation list')
  expect(html.includes('最近说过话'), 'the picker no longer marks the conversation the Host would pick')
  for (const label of ['对话', '时间', '级别']) {
    expect(html.includes(`>${label}</button>`), `the ${label} grouping button is missing`)
  }
  // Grouping must not smuggle raw colours in: theme tokens only.
  expect(/rgb\(|#[0-9a-fA-F]{3,6}\b/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')) === false, 'a literal colour leaked into the markup')
  return failures
}

if (process.argv.includes('--check')) {
  const failures = checkRenderedPanel(panelHtml, detailHtml)
  if (failures.length > 0) {
    console.error('panel render check failed:')
    for (const failure of failures) console.error(' -', failure)
    process.exit(1)
  }
  console.log('panel render: ok')
}

// The mounted panel polls while it is open; this tool is a one-shot render.
process.exit(0)
