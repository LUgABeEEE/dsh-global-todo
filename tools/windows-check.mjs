#!/usr/bin/env node
/**
 * A Windows-shaped smoke test that uses the real filesystem.
 *
 * The unit suite runs everywhere, but it fakes `fs`. This one writes, renames,
 * re-reads and cleans up in the temp directory of whatever machine runs it, so a
 * Windows tester gets a straight answer without needing the repository checked out
 * at a particular commit:
 *
 *   node tools/windows-check.mjs
 *   npm run check:windows
 *
 * Exits 1 on the first failed check, and prints the platform facts either way.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createService } from '../lib/service.js'
import { fromMarkdown, toMarkdown } from '../lib/markdown.js'

const results = []
const check = async (name, run) => {
  try {
    const detail = await run()
    results.push({ name, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) })
  }
}

const dir = await mkdtemp(path.join(tmpdir(), 'gt-windows-'))
const file = path.join(dir, 'global-todo', 'todos.json')
const store = createStore({ file })
const service = createService({ store, config: { requireExistingFiles: false } })

await check('create a store on this filesystem', async () => {
  const todo = await service.create({ title: 'Windows 冒烟：新建', tags: ['smoke'] }, { by: 'human' })
  const doc = JSON.parse(await readFile(file, 'utf8'))
  if (doc.todos.length !== 1) throw new Error('file does not contain the new todo')
  return `${todo.title} → ${path.basename(file)}`
})

await check('update, complete and review survive a reload', async () => {
  const [todo] = await service.listAll()
  await service.update(todo.id, { title: 'Windows 冒烟：改名', steps: [{ text: '一步', done: false }] }, { by: 'human' })
  await service.complete(todo.id, { summary: '完成' }, { by: 'agent' })
  const fresh = createStore({ file })
  const reloaded = await fresh.all()
  const found = reloaded.find((entry) => entry.id === todo.id)
  if (found === undefined) throw new Error('todo missing after reload')
  if (found.status !== 'done') throw new Error('completion did not persist')
  if (found.review?.pending !== true) throw new Error('review claim did not persist')
  return 'rename + completion + review claim'
})

await check('no *.tmp debris is left behind', async () => {
  const entries = await readdir(path.dirname(file))
  const debris = entries.filter((name) => name.endsWith('.tmp'))
  if (debris.length > 0) throw new Error(`debris: ${debris.join(', ')}`)
  return `${entries.length} file(s), none temporary`
})

await check('a large document (500 todos) writes and reads back', async () => {
  for (let index = 0; index < 500; index += 1) {
    await service.create({ title: `批量 ${index}`, tags: ['bulk'] }, { by: 'human' })
  }
  const all = await service.listAll()
  if (all.length < 500) throw new Error(`expected 500+, got ${all.length}`)
  return `${all.length} todos, ${(await readFile(file, 'utf8')).length} bytes`
})

await check('a CRLF markdown file imports like an LF one', async () => {
  const markdown = '# 待办\r\n\r\n- [ ] Windows 导入\r\n      标签: 导入\r\n'
  const parsed = fromMarkdown(markdown)
  if (parsed.todos.length !== 1) throw new Error('CRLF document did not parse')
  const round = fromMarkdown(toMarkdown({ todos: parsed.todos }, { now: Date.now() }))
  if (round.todos.length !== 1) throw new Error('round-trip lost the todo')
  return 'CRLF in, todo out'
})

await check('a path with spaces and non-ASCII characters works', async () => {
  const nested = path.join(dir, '含 空格 的 目录', 'todos.json')
  const nestedStore = createStore({ file: nested })
  const nestedService = createService({ store: nestedStore, config: { requireExistingFiles: false } })
  await nestedService.create({ title: '路径 有 空格' }, { by: 'human' })
  const parsed = JSON.parse(await readFile(nested, 'utf8'))
  if (parsed.todos.length !== 1) throw new Error('nested path did not persist')
  return path.basename(nested)
})

await check('an atomic rename over an existing file replaces it', async () => {
  const target = path.join(dir, 'rename-target.json')
  await writeFile(target, '{"version":1,"todos":[]}', 'utf8')
  const store2 = createStore({ file: target })
  await writeFile(target, '{"version":1,"todos":[]}', 'utf8')
  await createService({ store: store2, config: { requireExistingFiles: false } }).create({ title: '覆盖' }, { by: 'human' })
  const parsed = JSON.parse(await readFile(target, 'utf8'))
  if (parsed.todos.length !== 1) throw new Error('rename did not replace the file')
  return 'replaced in place'
})

await rm(dir, { recursive: true, force: true })

const width = Math.max(...results.map((entry) => entry.name.length))
process.stdout.write(`platform ${process.platform} · node ${process.version} · ${path.sep === '\\' ? 'backslash' : 'slash'} separator\n\n`)
for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name.padEnd(width)}  ${entry.detail}\n`)
}
const failed = results.filter((entry) => !entry.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`)
if (process.platform !== 'win32') {
  process.stdout.write('note: this run is on ' + process.platform + '; the Windows-specific paths above\n' +
    'are exercised by the same code, but run it on Windows for a real answer.\n')
}
process.exit(failed.length === 0 ? 0 : 1)
