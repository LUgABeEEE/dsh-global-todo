#!/usr/bin/env node
/**
 * The contract matrix a reviewer keeps re-testing by hand.
 *
 * Every Windows test round so far has produced the same shape of report: not "a function
 * is broken" but "the same invalid input is treated three different ways depending on the
 * field". This script encodes those cross-field rules so a release can be checked locally
 * before it reaches a tester, on either platform:
 *
 *   npm run check:contracts
 *   node tools/contracts-check.mjs
 *
 * It is deliberately module-level and offline: no browser, no host, no network, no
 * fixture files outside os.tmpdir(). Exit code is the number of failed groups.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createSettings, SETTINGS_DEFAULTS } from '../lib/settings.js'
import { createRoutes, ROUTE_BASE } from '../lib/routes.js'
import { createService } from '../lib/service.js'
import { createStore } from '../lib/store.js'
import { createTodo, isValidDue, LIMITS, normalizeDue } from '../lib/model.js'
import { createTools, selectTools, TOOL_GROUPS } from '../lib/tools.js'
import { DEFAULT_MIN_WEIGHT, scoreItem } from '../lib/weight.js'
import { findDuplicate } from '../lib/capture.js'

const results = []
const check = (group, name, ok, detail) => {
  results.push({ group, name, ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail === undefined ? '' : `  ·  ${detail}`}\n`)
}
const equal = (group, name, actual, expected) =>
  check(group, name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

// ── A. The weight baselines the changelog promises ─────────────────────────────────────
{
  const hedged = scoreItem({ title: '回头再说吧，有空看看' }).weight
  const plain = scoreItem({ title: '取快递' }).weight
  const withDue = scoreItem({ title: '周五前提交季度报告', dueAt: '2026-10-24T10:00:00+08:00' }).weight
  equal('A weight', 'hedged one-liner', hedged, 0.3)
  equal('A weight', 'plain errand', plain, 0.4)
  equal('A weight', 'with deadline', withDue, 0.75)
  equal('A weight', 'default threshold', DEFAULT_MIN_WEIGHT, 0.35)
  check('A weight', 'hedged falls below, plain stays above', hedged < DEFAULT_MIN_WEIGHT && plain >= DEFAULT_MIN_WEIGHT)
}

// ── B. The gate uses <, so a candidate exactly at the threshold is registered ───────────
{
  const created = []
  const service = {
    async list() { return { todos: [] } },
    async create(input) {
      const todo = createTodo({ title: 'stub' })
      created.push({ ...todo, ...input })
      return created.at(-1)
    },
  }
  const tools = createTools(service, { settings: { get: () => ({ captureMinWeight: 0.3 }) } })
  const tool = tools.find((definition) => definition.name === 'global_todo_capture')
  const atThreshold = await tool.execute({ items: [{ title: '回头再说吧，有空看看' }] }, {})
  check('B gate', 'weight equal to the threshold is registered', atThreshold.count === 1, `count=${atThreshold.count}`)
  // A second instance, because the first one was handed a 0.3 threshold on purpose.
  const defaultTools = createTools(service, {})
  const defaultTool = defaultTools.find((definition) => definition.name === 'global_todo_capture')
  const below = await defaultTool.execute({ items: [{ title: '回头再说吧，有空看看' }] }, {})
  equal('B gate', 'but the default threshold skips it', below.count, 0)
}

// ── C. One invalid value, one answer, whichever field it lands on ──────────────────────
{
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-contracts-'))
  const settings = createSettings({ file: path.join(dir, 'settings.json') })
  const routes = createRoutes({
    service: { async stats() { return {} }, async describe() { return {} }, async awaitingReview() { return [] } },
    dispatcher: { capabilities: () => ({}), sessionAlive: () => false, sessionDir: () => '', dispatch: async () => ({}) },
    settings,
    version: 'test',
    diagnostics: { recent: () => [], record: () => null },
    metrics: { snapshot: () => null },
  })
  const route = routes.find((candidate) => candidate.path === `${ROUTE_BASE}/settings`)
  const call = async (payload) => {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))])
    request.method = 'POST'
    request.url = `${ROUTE_BASE}/settings`
    request.headers = { 'content-type': 'application/json', host: '127.0.0.1:1' }
    request.socket = { remoteAddress: '127.0.0.1', remotePort: 1 }
    let body = ''
    const response = {
      statusCode: 200,
      writableEnded: false,
      setHeader() {},
      end(chunk) { this.writableEnded = true; if (chunk) body = String(chunk) },
    }
    await route.handler(request, response)
    return { status: response.statusCode, body: body === '' ? null : JSON.parse(body) }
  }
  const before = settings.get()
  for (const field of ['captureMinWeight', 'idleMinutes', 'cooldownMinutes', 'reminderLeadMinutes', 'ingestConfirmBelow']) {
    const response = await call({ [field]: null })
    equal('C validation', `null on ${field}`, response.status, 400)
  }
  equal('C validation', 'a null did not move any stored value', settings.get(), before)
  equal('C validation', 'wrong type string', (await call({ captureMinWeight: '0.5' })).status, 400)
  equal('C validation', 'wrong type boolean', (await call({ captureMinWeight: true })).status, 400)
  equal('C validation', 'wrong type array', (await call({ captureMinWeight: [] })).status, 400)
  equal('C validation', 'unknown key', (await call({ captureMinWeightt: 0.5 })).status, 400)
  equal('C validation', 'out of range', (await call({ captureMinWeight: 2 })).status, 400)
  equal('C validation', 'fractional minute', (await call({ idleMinutes: 30.5 })).status, 400)
  equal('C validation', 'three-decimal weight', (await call({ captureMinWeight: 0.345 })).status, 400)
  equal('C validation', 'two-decimal weight is stored as sent', (await call({ captureMinWeight: 0.34 })).status, 200)
  equal('C validation', 'stored weight', settings.get().captureMinWeight, 0.34)
  equal('C validation', 'defaults are untouched otherwise', settings.get().idleMinutes, SETTINGS_DEFAULTS.idleMinutes)
  await rm(dir, { recursive: true, force: true })
}

// ── D. Deadlines: a real date or a refusal, never an invented one ──────────────────────
{
  for (const value of ['2026', '2026-10', 'October 2026', '2026-02-31', '30', 'tomorrow', '2026-13-01', '2026-10-20T24:00']) {
    check('D due', `rejects ${JSON.stringify(value)}`, isValidDue(value) === false)
  }
  for (const value of ['2026-10-20', '2026-10-20T10:00', '2026-10-20 10:00', '2026-10-20T10:00:30Z', '2026-10-20T10:00+08:00']) {
    check('D due', `accepts ${JSON.stringify(value)}`, isValidDue(value) === true)
  }
  check('D due', 'normalizeDue returns ISO', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(normalizeDue('2026-10-20T10:00')))
  // Issue #6: a date-only deadline is the local start of that day, not UTC midnight.
  equal('D due', 'date-only is local midnight', normalizeDue('2026-10-20'), new Date(2026, 9, 20).toISOString())
}

// ── E. Steps: empty is a refusal, not a silent drop ────────────────────────────────────
{
  let threw = false
  try { createTodo({ title: 'x', steps: ['  '] }) } catch (error) { threw = error?.code === 'invalid-steps' }
  check('E steps', 'blank step is refused', threw)
  equal('E steps', 'blank steps earn no weight', scoreItem({ title: 'x', steps: [''] }).signals.some((signal) => signal.id === 'steps'), false)
}

// ── F. Dedupe: an appended addendum is the same errand, a replaced one is not ──────────
{
  const now = Date.now()
  const done = (title) => [{ id: 't1', title, status: 'done', createdAt: now - 86_400_000, updatedAt: now - 60_000, doneAt: now - 60_000 }]
  for (const title of ['X', 'T3 逾期项', '写周报', '配置小米 NAS 证书']) {
    equal('F dedupe', `addendum on ${title}`, findDuplicate({ title: `${title}（再办一次）`, existing: done(title), now }).duplicate, true)
  }
  equal('F dedupe', 'replaced parenthetical is different work', findDuplicate({ title: '修 A（前端）', existing: done('修 A（后端）'), now }).duplicate, false)
}

// ── G. Sorting is a total order, even when timestamps tie ──────────────────────────────
{
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-contracts-sort-'))
  const frozen = 1_700_000_000_000
  const service = createService({ store: createStore({ file: path.join(dir, 'todos.json') }), config: { requireExistingFiles: false }, now: () => frozen })
  const a = await service.create({ title: 'a' })
  const b = await service.create({ title: 'b' })
  const c = await service.create({ title: 'c' })
  const expected = [c.id, b.id, a.id]
  for (const sort of ['created', 'updated', 'due', 'priority']) {
    const ordered = (await service.list({ status: 'all', sort })).todos.map((todo) => todo.id)
    equal('G sort', `${sort} is newest-first on tied timestamps`, ordered, expected)
  }
  await rm(dir, { recursive: true, force: true })
}

// ── H. Title limits are one number, not two ────────────────────────────────────────────
{
  const tool = createTools({ async create() {}, async list() { return { todos: [] } } }, {}).find((definition) => definition.name === 'global_todo_capture')
  equal('H limits', 'ingest and model share the title cap', LIMITS.title, 200)
  check('H limits', 'a title at the cap is accepted by the model', createTodo({ title: 'x'.repeat(LIMITS.title) }).title.length === LIMITS.title)
  check('H limits', 'and one character over is refused', (() => { try { createTodo({ title: 'x'.repeat(LIMITS.title + 1) }) } catch (error) { return error?.code === 'invalid-title' } return false })())
  void tool
}

// ── I. Tool groups: switching tools off must not leave guidance behind ─────────────────
{
  const defs = createTools({ async create() {}, async list() { return { todos: [] } } }, {})
  const names = (mode) => selectTools(defs, mode).map((definition) => definition.name)
  equal('I groups', 'all registers eleven', names('all').length, 11)
  equal('I groups', 'core is the list itself', names('core'), [...TOOL_GROUPS.core])
  equal('I groups', 'none registers nothing', names('none').length, 0)
  equal('I groups', 'a typo falls back to all', names('nonsense'), names('all'))
  const { guidanceFor, memoryGuidanceFor } = await import('../lib/index.js')
  equal('I groups', 'no tools, no guidance', guidanceFor('none'), '')
  check('I groups', 'core guidance does not name the capture tool', guidanceFor('core').includes('global_todo_capture') === false)
  equal('I groups', 'no tools, no memory bridge either', memoryGuidanceFor('none'), '')
  check('I groups', 'the bridge names the memory tool and this list', memoryGuidanceFor('all').includes('mnemon_remember') && memoryGuidanceFor('all').includes('global_todo_list'))
  equal('I groups', 'the bridge never names a tool the core set lacks', memoryGuidanceFor('core'), memoryGuidanceFor('all'))
}

// ── J. The cross-process lock: a write that cannot happen must say so ──────────────────
{
  const { createFileLock, LOCK_STALE_MS, LOCK_TIMEOUT_MS } = await import('../lib/lockfile.js')
  const { ERROR_CODES } = await import('../lib/errors.js')
  const { statusForCode } = await import('../lib/routes.js')

  equal('J lock', 'store-busy is a declared code', ERROR_CODES.includes('store-busy'), true)
  equal('J lock', 'and maps to 503, not 500', statusForCode('store-busy'), 503)
  equal('J lock', 'the wait budget a person is told about', LOCK_TIMEOUT_MS, 5000)
  equal('J lock', 'a remote holder is presumed gone after', LOCK_STALE_MS, 30_000)

  const dir = await mkdtemp(path.join(tmpdir(), 'gt-contract-lock-'))
  try {
    const file = path.join(dir, 'todos.json.lock')
    const first = createFileLock({ file, timeoutMs: 100 })
    const second = createFileLock({ file, timeoutMs: 100 })
    await first.acquire()
    let code = null
    await second.acquire().catch((error) => {
      code = error.code
    })
    equal('J lock', 'a second writer is refused, not allowed to interleave', code, 'store-busy')
    await first.release()
    let after = false
    await second
      .acquire()
      .then(() => {
        after = true
        return second.release()
      })
      .catch(() => {})
    equal('J lock', 'and gets in as soon as the first one is done', after, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── K. Multi-machine: a copy that comes back must not undo a deletion ──────────────────
{
  const { mergeDocuments, TOMBSTONE_TTL_MS } = await import('../lib/replica.js')
  const { HUB_FILE } = await import('../lib/sync.js')
  const { ERROR_CODES } = await import('../lib/errors.js')
  const { statusForCode } = await import('../lib/routes.js')

  const newer = { todos: [{ id: 't-a', title: 'a', seq: 1, createdAt: 1, updatedAt: 100 }], trash: [] }
  const older = { todos: [{ id: 't-a', title: 'a', seq: 1, createdAt: 1, updatedAt: 50 }], trash: [] }
  equal('K sync', 'the newer copy of one record wins', mergeDocuments(newer, older).todos[0].updatedAt, 100)
  equal(
    'K sync',
    'and the fold does not depend on which side came first',
    JSON.stringify(mergeDocuments(newer, older).todos),
    JSON.stringify(mergeDocuments(older, newer).todos),
  )

  const deleted = { todos: [], trash: [{ id: 't-b', at: 200, by: 'human' }] }
  const stale = { todos: [{ id: 't-b', title: 'b', seq: 2, createdAt: 1, updatedAt: 100 }], trash: [] }
  equal('K sync', 'an older copy cannot bring a deleted record back', mergeDocuments(stale, deleted).todos.length, 0)
  equal('K sync', 'a deletion is remembered for a year', TOMBSTONE_TTL_MS, 365 * 24 * 60 * 60 * 1000)
  equal('K sync', 'the hub has one documented name', HUB_FILE, 'todos.hub.json')

  const declared = ['sync-not-configured', 'sync-busy', 'sync-unavailable', 'sync-corrupt', 'sync-failed', 'sync-timeout']
  equal('K sync', 'every sync failure is a declared code', declared.every((code) => ERROR_CODES.includes(code)), true)
  equal('K sync', 'an unreachable share is 503, not an internal error', statusForCode('sync-unavailable'), 503)
  equal('K sync', 'a corrupt hub is 500, because retrying cannot fix it', statusForCode('sync-corrupt'), 500)
  equal('K sync', 'the sync tool is not part of the core list', TOOL_GROUPS.core.includes('global_todo_sync'), false)

  // The configuration is a deployment fact, and the documentation is the only place a person
  // can learn the key's name. A README that never mentions `sync.dir` makes it unreachable.
  const { normalizeSyncDir, SETTINGS_DEFAULTS } = await import('../lib/settings.js')
  equal('K sync', 'a relative directory names nothing', normalizeSyncDir('nas/todo'), '')
  equal('K sync', 'a trailing separator is not a second share', normalizeSyncDir('/mnt/x/'), '/mnt/x')
  equal('K sync', 'a drive root keeps its separator', normalizeSyncDir('C:\\'), 'C:\\')
  equal('K sync', 'a machine starts on its own', SETTINGS_DEFAULTS.syncDir, '')
  equal('K sync', 'and folds every five minutes once pointed somewhere', SETTINGS_DEFAULTS.syncMinutes, 5)

  const zh = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const en = await readFile(new URL('../README.en.md', import.meta.url), 'utf8')
  check('K sync', 'the Chinese README documents sync.dir', zh.includes('sync.dir'))
  check('K sync', 'the English README documents sync.dir', en.includes('sync.dir'))
  check('K sync', 'the Chinese README names the hub file', zh.includes(HUB_FILE))
  check('K sync', 'the English README names the hub file', en.includes(HUB_FILE))
}

const failed = results.filter((result) => !result.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} contract checks passed\n`)
process.exit(failed.length === 0 ? 0 : Math.min(failed.length, 1))

