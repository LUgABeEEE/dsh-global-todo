/**
 * The dispatch gate: what may be handed to an agent, and what that would cost.
 *
 * Handing a record over is cheap to do and expensive to undo: a worker starts in its own
 * session, touches a directory, and the person now has two conversations to follow instead of
 * one. The rules here are deliberately boring and few, because a gate nobody can recite is a
 * gate people route around.
 *
 * Pure, like `triage.js`: the policy decision must be the same whether it is asked by the
 * panel, by the tick, or by a test. Nothing in this module writes.
 *
 * @module dsh-global-todo/gate
 */

import { homedir } from 'node:os'

import { isInbox } from './model.js'
import { CLASSIFY_TAGS, isSnoozed } from './triage.js'

/** Default tag that marks a record as "an agent may take this". */
export const DISPATCH_TAG = CLASSIFY_TAGS.auto

/**
 * Storage and system roots a worker must not be started in, matched as prefixes.
 *
 * The home directory is handled separately, and only **exactly**: on this deployment the whole
 * workspace lives under `~`, so a prefix rule for home would refuse every real project and be
 * switched off within a day. What it protects is the directory itself — the place where one
 * stray recursive delete is not recoverable — while a named project below it is exactly the
 * kind of place a worker is supposed to run.
 */
export function defaultDenyDirs() {
  return ['/pool0', '/mnt/nas']
}

/** @type {{ tag: string, dailyCap: number, cooldownDays: number, denyDirs: string[] }} */
export const DEFAULT_POLICY = Object.freeze({
  tag: DISPATCH_TAG,
  dailyCap: 2,
  cooldownDays: 3,
  denyDirs: [],
})

/** Codes are part of the wire contract; the panel localises them. */
export const GATE_CODES = Object.freeze([
  'inbox',
  'not-active',
  'snoozed',
  'no-tag',
  'no-dir',
  'dir-unsafe',
  'already-live',
  'cooldown',
  'dir-cooldown',
  'daily-cap',
  'allowed',
])

const clampInt = (value, low, high, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), low), high) : fallback
}

/**
 * @param {unknown} raw
 * @param {{ home?: string }} [options]
 * @returns {{ tag: string, dailyCap: number, cooldownDays: number, denyDirs: string[] }}
 */
export function normalizePolicy(raw, options = {}) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const tag = typeof source.tag === 'string' && source.tag.trim() !== '' ? source.tag.trim() : DEFAULT_POLICY.tag
  // Zero is meaningful ("no hand-offs today"), and so is a cap of zero days, so both are kept
  // rather than replaced by the default.
  const dailyCap = clampInt(source.dailyCap, 0, 10, DEFAULT_POLICY.dailyCap)
  const cooldownDays = clampInt(source.cooldownDays, 0, 30, DEFAULT_POLICY.cooldownDays)
  const denyDirs = Array.isArray(source.denyDirs) && source.denyDirs.length > 0
    ? source.denyDirs.filter((dir) => typeof dir === 'string' && dir !== '')
    : defaultDenyDirs()
  return { tag, dailyCap, cooldownDays, denyDirs }
}

/**
 * A local calendar day as `YYYY-MM-DD`.
 *
 * Local, not UTC: 「今天派了几条」 is asked by a person in a timezone, and a UTC day boundary
 * would flip the budget in the middle of an afternoon.
 *
 * @param {number} at
 * @returns {string}
 */
export function dayKey(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * What the last dispatch ledger says about today and about each directory.
 *
 * `lastDispatch` is the only hand-off record this store keeps (one per todo, by design — a
 * second ledger would be a second thing to disagree with). It is enough for a daily cap and a
 * per-directory cooldown, with one known limitation: a record handed over twice in one day
 * counts once. That under-counts, which is the safe direction for a budget.
 *
 * @param {object[]} todos
 * @param {number} now
 * @returns {{ day: string, used: number, byDir: Record<string, number> }}
 */
export function budgetOf(todos, now = Date.now()) {
  const day = dayKey(now)
  let used = 0
  /** @type {Record<string, number>} */
  const byDir = {}
  for (const todo of Array.isArray(todos) ? todos : []) {
    const at = Number(todo?.lastDispatch?.at)
    if (!Number.isFinite(at) || at <= 0) continue
    if (dayKey(at) === day) used += 1
    const dir = typeof todo.lastDispatch.dir === 'string' ? todo.lastDispatch.dir : todo.originDir ?? ''
    if (dir === '') continue
    if (!Number.isFinite(byDir[dir]) || byDir[dir] < at) byDir[dir] = at
  }
  return { day, used, byDir }
}

/**
 * Is this directory one a worker may be started in?
 *
 * Prefix matching is deliberate: `~/projects` is inside `~`, and the rule about `~` is about
 * everything below it too.
 *
 * @param {string} dir
 * @param {string[]} denyDirs
 * @returns {boolean}
 */
export function isUnsafeDir(dir, denyDirs = defaultDenyDirs(), home = homedir()) {
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  // `/` and `C:/` reduce to nothing here, and both mean "the whole filesystem".
  if (normalized === '') return true
  // A drive root (`C:`, `C:/`) is "the whole computer", not a project.
  if (/^[A-Za-z]:$/.test(normalized)) return true
  const homeDir = typeof home === 'string' ? home.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (homeDir !== '' && normalized === homeDir) return true
  return denyDirs.some((raw) => {
    const base = raw.replace(/\\/g, '/').replace(/\/+$/, '')
    if (base === '') return false
    if (normalized === base) return true
    return normalized.startsWith(`${base}/`)
  })
}

/**
 * May this record be handed to an agent right now?
 *
 * @param {object} todo
 * @param {{
 *   now: number,
 *   policy: ReturnType<typeof normalizePolicy>,
 *   usedToday: number,
 *   byDir: Record<string, number>,
 *   sessionAlive?: boolean,
 * }} context
 * @returns {{ allowed: boolean, code: string, reason: string, waitHours?: number }}
 */
export function evaluate(todo, context) {
  const now = context.now
  const policy = context.policy
  const deny = (code, reason, extra = {}) => ({ allowed: false, code, reason, ...extra })

  if (isInbox(todo)) return deny('inbox', '还在收件箱里，等人确认过才谈得上派发')
  if (todo.status !== 'open' && todo.status !== 'doing') return deny('not-active', `状态是 ${todo.status}，不是活的事`)
  // A deferred record said "not today". Dispatching it would override a decision the person
  // already made, and the deferral is the one signal that is purely human.
  if (isSnoozed(todo, now)) return deny('snoozed', '这条被推迟过，今天不该动它')

  const tags = Array.isArray(todo.tags) ? todo.tags.map((tag) => String(tag).toLowerCase()) : []
  if (!tags.includes(policy.tag.toLowerCase())) return deny('no-tag', `没有「${policy.tag}」标签，没人说过它可以自动做`)

  const dir = typeof todo.originDir === 'string' ? todo.originDir.trim() : ''
  if (dir === '') return deny('no-dir', '没有来源目录：worker 会在自己选的地方开工，那不该由一条待办决定')
  if (isUnsafeDir(dir, policy.denyDirs)) return deny('dir-unsafe', `来源目录不是可开工的地方：${dir}`)

  // A live session already has the record; handing it over again is how one task becomes two
  // conversations disagreeing about the same file.
  if (context.sessionAlive === true) return deny('already-live', '绑定的会话还在跑，再派一次就是两个会话做同一件事')

  const lastAt = Number(todo.lastDispatch?.at)
  if (Number.isFinite(lastAt) && lastAt > 0) {
    const hours = (now - lastAt) / 3_600_000
    if (hours < policy.cooldownDays * 24) {
      const waitHours = Math.ceil(policy.cooldownDays * 24 - hours)
      return deny('cooldown', `这条 ${Math.floor(hours)} 小时前刚派过，再等 ${waitHours} 小时`, { waitHours })
    }
  }

  const dirAt = Number(context.byDir?.[dir])
  if (Number.isFinite(dirAt) && dirAt > 0) {
    const hours = (now - dirAt) / 3_600_000
    if (hours < policy.cooldownDays * 24) {
      const waitHours = Math.ceil(policy.cooldownDays * 24 - hours)
      return deny('dir-cooldown', `同一目录 ${Math.floor(hours)} 小时前刚派过，避免两个 worker 抢同一批文件`, { waitHours })
    }
  }

  // The budget is the last word on purpose: "the policy allows it" is not "we can afford it
  // today", and a person reading the panel needs the second answer.
  if (context.usedToday >= policy.dailyCap) {
    return deny(
      'daily-cap',
      policy.dailyCap === 0 ? '今天的派发预算被设成 0' : `今天已经派了 ${context.usedToday} 条，预算 ${policy.dailyCap} 条`,
    )
  }

  return { allowed: true, code: 'allowed', reason: '可以派' }
}

/**
 * The whole plan for one tick: which records the gate would let through, and which it refuses.
 *
 * @param {object[]} todos
 * @param {{ now: number, policy: ReturnType<typeof normalizePolicy>, sessionAlive?: (id: string) => boolean }} context
 * @returns {{ budget: ReturnType<typeof budgetOf>, allowed: object[], refused: object[] }}
 */
export function planDispatch(todos, context) {
  const now = context.now
  const policy = context.policy
  const budget = budgetOf(todos, now)
  const allowed = []
  const refused = []
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (todo === null || typeof todo !== 'object') continue
    const verdict = evaluate(todo, {
      now,
      policy,
      usedToday: budget.used,
      byDir: budget.byDir,
      // Asked per record, because liveness is a fact about now, not about the file.
      sessionAlive: typeof context.sessionAlive === 'function' ? context.sessionAlive(todo.sessionId) === true : false,
    })
    const entry = { id: todo.id, title: todo.title, code: verdict.code, reason: verdict.reason, ...(verdict.waitHours === undefined ? {} : { waitHours: verdict.waitHours }) }
    if (verdict.allowed) allowed.push(entry)
    else refused.push(entry)
  }
  return { budget, allowed, refused }
}
