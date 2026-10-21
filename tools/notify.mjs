#!/usr/bin/env node
/**
 * Push a short message to the user's WeChat through the host's delivery library.
 *
 * The authority on whether this works is the host's `night/lib/delivery.sh`: it holds the
 * freshness window (a WeChat context token goes stale after roughly 18 hours without a
 * message from the user) and the outbox that exists so a message sent outside the window
 * is retried later instead of being lost. This file only composes messages and decides
 * which of those two paths to take; it does not reimplement either.
 *
 *   node tools/notify.mjs "任意一句话"
 *   node tools/notify.mjs release 0.12.9
 *   node tools/notify.mjs ci-failed 39591615478 v0.12.9 "Package shape"
 *   node tools/notify.mjs new-issue 3 "Windows 0.12.6 test sweep"
 *   node tools/notify.mjs --dry-run release 0.12.9   # compose and report the window, send nothing
 *
 * Exit codes: 0 sent, 3 queued in the outbox, 4 lost (send and queue both failed), 2 no channel.
 *
 * @module dsh-global-todo/notify
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import glob from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

/** Where the host keeps the delivery library and the WeChat integration state. */
// Derived, never written down: this checkout sits on a machine whose home happens to be the
// agent workdir, and an absolute path here is also a path leak in the published repo.
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const WORKDIR = process.env.DSH_NOTIFY_WORKDIR ?? path.join(os.homedir(), 'night')

export const DELIVERY = Object.freeze({
  library: path.join(WORKDIR, 'lib', 'delivery.sh'),
  outbox: path.join(WORKDIR, 'outbox'),
  accounts: path.join(HOME, 'integrations', 'dsh-weixin', 'accounts'),
  /** Measured boundary: 65514s succeeded, 65578s failed (http502). */
  windowSeconds: 65_536,
})

/**
 * Age of the freshest WeChat context token, in seconds.
 *
 * Only timestamps are read. No message text, no account id.
 *
 * @param {{ accountsDir?: string, readdir?: Function } | undefined} [options]
 * @returns {Promise<number | null>} null when there is no token to age
 */
export async function windowAgeSeconds(options = {}) {
  const dir = options.accountsDir ?? DELIVERY.accounts
  const readdir = options.readdir ?? (async (target) => glob.readdir(target))
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  let newest = 0
  for (const entry of entries) {
    let state
    try {
      state = JSON.parse(await readFile(path.join(dir, entry, 'state.json'), 'utf8'))
    } catch {
      continue
    }
    const users = state?.contextTokens?.users
    if (users === null || typeof users !== 'object') continue
    for (const value of Object.values(users)) {
      const at = value?.messageTimeMs
      if (Number.isFinite(at) && at > newest) newest = at
    }
  }
  if (newest === 0) return null
  return Math.max(0, (Date.now() - newest) / 1000)
}

/**
 * @param {number | null} age seconds, or null when unknown
 * @param {number} [limit]
 * @returns {'open' | 'stale' | 'unknown'}
 */
export function windowState(age, limit = DELIVERY.windowSeconds) {
  if (age === null || !Number.isFinite(age)) return 'unknown'
  return age < limit ? 'open' : 'stale'
}

/**
 * @param {number | null} age
 * @returns {string} a phrase for the log line, never the message body
 */
export function describeAge(age) {
  if (age === null || !Number.isFinite(age)) return 'unknown'
  const hours = age / 3600
  return hours < 1 ? `${Math.round(age)}s` : `${hours.toFixed(1)}h`
}

const REPO = 'https://github.com/LUgABeEEE/dsh-global-todo'

/**
 * The three events this repository actually has.
 *
 * @param {{ kind: 'text' | 'release' | 'ci-failed' | 'new-issue', args: string[] }} input
 * @returns {string}
 */
export function compose({ kind, args }) {
  if (kind === 'text') {
    const text = args.join(' ').trim()
    if (text === '') throw new Error('空消息：给我一句话')
    return text
  }
  if (kind === 'release') {
    const version = args[0]
    if (version === undefined) throw new Error('用法：release <版本>')
    return [
      `【dsh-global-todo ${version} 已发布】`,
      '',
      `npm：https://www.npmjs.com/package/dsh-global-todo/v/${version}`,
      `release：${REPO}/releases/tag/v${version}`,
      '',
      '装：dsh plugin add dsh-global-todo@' + version + '（装完重启 dsh web）',
    ].join('\n')
  }
  if (kind === 'ci-failed') {
    const [runId, branch, job] = args
    if (runId === undefined) throw new Error('用法：ci-failed <runId> [分支] [job 名]')
    return [
      `【CI 转红】${branch ?? ''} ${job ?? ''}`.replace(/\s+$/, ''),
      '',
      `运行：${REPO}/actions/runs/${runId}`,
    ].join('\n')
  }
  if (kind === 'new-issue') {
    const [number, title] = args
    if (number === undefined) throw new Error('用法：new-issue <编号> [标题]')
    return [`【新 issue #${number}】${title ?? ''}`.replace(/\s+$/, ''), '', `${REPO}/issues/${number}`].join('\n')
  }
  throw new Error(`不认识的事件：${kind}`)
}

/**
 * Send, or queue when the window is closed.
 *
 * @param {{ text: string, library?: string, outbox?: string, exec?: Function, age?: number | null }} input
 * @returns {Promise<{ status: 'sent' | 'queued' | 'absent', detail: string }>}
 */
export async function deliver(input) {
  const library = input.library ?? DELIVERY.library
  const outbox = input.outbox ?? DELIVERY.outbox
  const exec = input.exec ?? run
  if (!existsSync(library)) return { status: 'absent', detail: `no delivery library at ${library}` }
  const age = input.age === undefined ? await windowAgeSeconds() : input.age
  const state = windowState(age)
  if (state === 'stale') {
    // Outside the window the platform answers http502; queueing is the difference between
    // "late" and "lost". delivery.sh owns the queue format.
    const queued = await exec(
      'bash',
      [
        '-c',
        // WORKDIR is derived in the shell from the library's own location, so the snippet
        // carries no machine-specific path.
        // The library lives at $WORKDIR/night/lib, and delivery.sh appends /night/outbox
        // to it, so WORKDIR is three levels up: the directory that contains night/.
        'WORKDIR=$(dirname "$(dirname "$(dirname "$1")")"); log(){ :; }; . "$1"; outbox_save "$2" "window-stale"',
        '--',
        library,
        input.text,
      ],
    )
    return { status: 'queued', detail: (queued.stdout ?? '').trim() || 'window closed' }
  }
  // Single quotes, not a template literal: `\${1}` inside backticks is a JS substitution
  // (the expression `1`), which shipped "1: No such file or directory" once.
  // execFile rejects on a non-zero exit, and delivery.sh exits non-zero on failure, so the
  // rejection is the normal "not sent" path, not an exception to leak to the caller.
  let detail = ''
  try {
    const sent = await exec('bash', ['-c', '. "$1"; notify_wechat "$2"', '--', library, input.text])
    const out = (sent.stdout ?? '').trim()
    if (out === 'ok') return { status: 'sent', detail: 'ok' }
    detail = out === '' ? 'empty reply' : out
  } catch (error) {
    const raw = String(error?.stdout ?? error?.stderr ?? error?.message ?? error).trim()
    detail = raw === '' ? 'delivery failed' : raw
  }
  // "Queued" has to mean queued: a failed send is written to the outbox so the retry the
  // window logic promises actually happens instead of staying a claim in this function.
  try {
    const queued = await exec(
      'bash',
      [
        '-c',
        'WORKDIR=$(dirname "$(dirname "$(dirname "$1")")"); log(){ :; }; . "$1"; outbox_save "$2" "delivery-failed"',
        '--',
        library,
        input.text,
      ],
    )
    const saved = (queued.stdout ?? '').trim()
    return { status: 'queued', detail: saved === '' ? detail : `${detail} → ${saved}` }
  } catch (error) {
    // Neither sent nor queued: say so, because a silent lose is the one outcome that must not
    // be reported as success.
    return { status: 'lost', detail: `${detail} (outbox failed: ${error?.message ?? error})` }
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const dryRun = argv[0] === '--dry-run'
  const [kind = 'text', ...rest] = dryRun ? argv.slice(1) : argv
  try {
    const text = compose({ kind, args: rest })
    const age = await windowAgeSeconds()
    if (dryRun) {
      process.stdout.write(`window ${windowState(age)} (${describeAge(age)})\n---\n${text}\n---\ndry run: nothing sent\n`)
      process.exit(0)
    }
    const result = await deliver({ text, age })
    process.stdout.write(`${result.status} (${describeAge(age)} old window, ${result.detail})\n`)
    // 0 sent, 3 queued (retried later), 4 lost (neither), 2 no channel on this host.
    process.exit(result.status === 'sent' ? 0 : result.status === 'queued' ? 3 : result.status === 'lost' ? 4 : 2)
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exit(1)
  }
}
