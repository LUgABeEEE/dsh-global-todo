/**
 * The browser panel's HTTP surface.
 *
 * The host half registers these on `ctx.webServer`; the client half calls them
 * with a **document-relative** path (`api/global-todo/list`) because the GUI
 * serves the app under `<base href="./">` and a root-absolute fetch would escape
 * that prefix in a sub-path deployment. Registration uses the required leading
 * slash.
 *
 * Security: these routes read and write a local, personal list, so they are
 * fenced twice — the Host's own connection fence (`connection.requestRejection`,
 * which enforces the Host/Origin rules and browser authentication) when the
 * service exists, and a strict loopback check as the fallback for leaner
 * compositions. A cross-site request never reaches a handler either way.
 *
 * Status codes are real: 400 for a rejected value, 404 for a missing todo,
 * 413 for an oversized body, 200 for success. The body always carries
 * `{ ok }`, so the panel can show the reason either way.
 *
 * @module dsh-global-todo/routes
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { TodoError, asTodoError } from './errors.js'
import { MAX_INGEST_ITEMS } from './ingest.js'
import { fromMarkdown, toMarkdown } from './markdown.js'
import { INGEST_SOURCES, normalizeSyncDir } from './settings.js'
import { weeklyReport } from './report.js'

/** Route prefix. The client appends this to the document base. */
export const ROUTE_BASE = '/api/global-todo'

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Only requests from this machine's own pages may touch the list.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
/**
 * Does this request look like it came from a browser page?
 *
 * Browsers attach cookies and an `Origin`; a script on the Host attaches neither.
 * The distinction matters because the Host's fence authenticates *browsers*, and a
 * credential-less local process is exactly the case the loopback rule below exists
 * for.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function hasBrowserCredentials(request) {
  const cookie = request.headers.cookie
  if (typeof cookie === 'string' && cookie.trim() !== '') return true
  const origin = request.headers.origin
  return typeof origin === 'string' && origin.trim() !== ''
}

export function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false

  let hostname
  try {
    hostname = new URL(`http://${request.headers.host ?? ''}`).hostname
  } catch {
    return false
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) return false

  return request.headers['sec-fetch-site'] !== 'cross-site'
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
/** Cap for an inline image; a screenshot is a few hundred KB, a 4K render is not. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024

/**
 * @param {string} file
 * @returns {string} the content type for a served image extension
 */
function mimeForImage(file) {
  const lower = String(file).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.avif')) return 'image/avif'
  return 'image/jpeg'
}
function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object>}
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new TodoError('payload-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TodoError('invalid-json', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof TodoError) throw error
    throw new TodoError('invalid-json', `请求体不是合法 JSON：${error?.message ?? error}`)
  }
}

/**
 * @param {string} code
 * @returns {number} the HTTP status that matches a machine code
 */
export function statusForCode(code) {
  if (code === 'not-found') return 404
  if (code === 'payload-too-large') return 413
  if (code === 'unauthorized') return 401
  if (code === 'forbidden') return 403
  // 503, not 500: the request failed because another process was writing, and the same request
  // will usually succeed a moment later. The panel shows the message and offers a retry.
  if (code === 'store-busy') return 503
  // The share is unreachable, stalled, or busy with another machine's write: the same request
  // usually succeeds once the mount answers, so it is "later", not "broken".
  if (code === 'sync-busy' || code === 'sync-unavailable' || code === 'sync-timeout') return 503
  if (code === 'sync-corrupt' || code === 'sync-failed') return 500
  if (code === 'store-corrupt' || code === 'store-unwritable' || code === 'internal') return 500
  if (code === 'agents-unavailable' || code === 'dispatch-failed') return 502
  return 400
}

/**
 * Build the route list.
 *
 * @param {object} deps
 * @param {object} deps.service
 * @param {object} deps.dispatcher
 * @param {object} [deps.logger]
 * @param {object} [deps.connection] - the Host connection service, when present
 * @param {{ registered: string[], error: string | null }} [deps.tools] - tool registry state for `/health`
 * @param {{ watching: boolean, error: string | null }} [deps.completion] - session watcher state for `/health`
 * @param {{ id: string, watching: boolean }} [deps.target] - recent-conversation tracking for `/health`
 * @param {{ snapshot?: Function }} [deps.metrics] - runtime counters for `/health`
 * @param {string} deps.version
 * @returns {Array<{ kind: string, path: string, handler: Function }>}
 */
export function createRoutes(deps) {
  const { service, dispatcher, version } = deps
  const config = deps.config
  const logger = deps.logger
  /**
   * The Host's connection fence, resolved **per request**.
   *
   * Reading it once at mount time was a real bug: the service can register after
   * this plugin, so the captured value was `undefined` and every request fell
   * through to the strict loopback check below — which rejects the trusted LAN and
   * tunnel addresses the Host itself allows, so the panel failed on every call for
   * anyone not browsing from the Host machine.
   */
  const fenceOf = () => {
    if (deps.connection !== undefined && deps.connection !== null) return deps.connection
    try {
      return deps.rootCtx?.get?.('connection') ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * @param {Function} handler
   * @returns {Function} a fenced handler
   */
  function route(handler) {
    return async (request, response) => {
      try {
        let rejection
        let fenceError = false
        const connection = fenceOf()
        try {
          rejection = connection?.requestRejection?.(request)
        } catch (error) {
          logger?.warn?.(`dsh-global-todo: connection 围栏异常：${error?.message ?? error}`)
          // A fence that cannot answer is not an approval: fail closed, and never let
          // the local-script carve-out below rescue it.
          rejection = 403
          fenceError = true
        }
        // The fence speaks for browsers: it authenticates them against this process's
        // token and its trusted-host list. A local, credential-less caller (a script
        // on the Host, `curl`, another agent) is not a browser and cannot be a
        // cross-site actor, so it is judged by the loopback rule instead — the same
        // rule that was the only guard before this service existed. Without that
        // carve-out, consulting the fence locks out the Host's own tooling, which is
        // how every request was verified until now.
        const fenced = typeof rejection === 'number' || (rejection !== undefined && rejection !== null)
        const localScript =
          fenceError !== true && isLoopbackRequest(request) && !hasBrowserCredentials(request)
        if (fenced && !localScript) {
          const status = typeof rejection === 'number' ? rejection : 403
          sendJson(response, status, { ok: false, reason: 'forbidden', error: '请求被宿主连接围栏拒绝' })
          return
        }
        // A fence that is present and did not object has already decided; only when
        // there is no fence at all does the loopback rule become the guard.
        if (!fenced && (connection === undefined || connection === null) && !isLoopbackRequest(request)) {
          sendJson(response, 403, { ok: false, reason: 'forbidden', error: '只接受本机请求' })
          return
        }
        const result = await handler(request, response)
        if (result !== undefined && !response.writableEnded) {
          sendJson(response, 200, { ok: true, data: result })
        }
      } catch (error) {
        const wrapped = asTodoError(error)
        if (wrapped.code === 'internal') {
          logger?.warn?.(`dsh-global-todo: ${request.method} ${request.url} 失败：${wrapped.stack ?? wrapped.message}`)
        }
        if (!response.writableEnded) sendJson(response, statusForCode(wrapped.code), wrapped.toJSON())
      }
    }
  }

  /**
   * @param {string} verb
   * @param {string} path
   * @param {Function} handler
   */
  function exact(verb, path, handler) {
    return {
      kind: 'exact',
      method: verb,
      path,
      handler: async (request, response) => {
        if (request.method !== verb) {
          response.setHeader('allow', verb)
          sendJson(response, 405, { ok: false, reason: 'method-not-allowed', error: `请用 ${verb}` })
          return
        }
        await route(handler)(request, response)
      },
    }
  }

  /**
   * One path, several verbs.
   *
   * The Host's route table is keyed by **path alone**: a second definition for the same
   * path throws `duplicate exact route` at registration, and since every route is
   * registered in one pass, that throw silently cost every route declared after it. On
   * 2026-10-29 that is exactly what happened — `/sync` was registered once for GET and
   * once for POST, so the panel's reads (declared earlier) worked while every write
   * (declared later) answered a bare 404. So a path that answers more than one verb is a
   * single registration that checks the verb itself.
   *
   * @param {string[]} allowed
   * @param {string} path
   * @param {Function} handler
   */
  function verbs(allowed, path, handler) {
    return {
      kind: 'exact',
      method: allowed.join(','),
      path,
      handler: async (request, response) => {
        if (allowed.includes(request.method) !== true) {
          response.setHeader('allow', allowed.join(', '))
          sendJson(response, 405, { ok: false, reason: 'method-not-allowed', error: `请用 ${allowed.join(' / ')}` })
          return
        }
        await route(handler)(request, response)
      },
    }
  }

  /** @param {import('node:http').IncomingMessage} request */
  const params = (request) => new URL(request.url ?? ROUTE_BASE, 'http://localhost').searchParams

  /**
   * Whose hand is on this request.
   *
   * The panel sends nothing — a person clicked a button, and that is the default.
   * A script acting *for an agent* has to say so, because the trail's whole purpose is
   * that a person can still tell the two apart afterwards. An unrecognised value is
   * refused rather than filed under `human`: absorbing a typo into the wrong
   * provenance is exactly the bug this parameter exists to fix.
   *
   * @param {object} body
   * @returns {'human' | 'agent'}
   */
  function actorOf(body) {
    const by = body?.by
    if (by === undefined || by === null || by === '' || by === 'human') return 'human'
    if (by === 'agent') return 'agent'
    throw new TodoError('invalid-body', `by 只能是 human / agent（缺省 human），收到 ${JSON.stringify(by)}`)
  }

  return [
    exact('GET', `${ROUTE_BASE}/list`, async (request) => {
      const query = params(request)
      const limit = Number.parseInt(query.get('limit') ?? '', 10)
      const result = await service.list({
        status: query.get('status') ?? 'active',
        query: query.get('query') ?? undefined,
        tag: query.get('tag') ?? undefined,
        sort: query.get('sort') ?? undefined,
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : undefined,
      })
      // A live-session flag is a runtime fact, not stored state: deriving it on
      // read keeps the panel honest without persisting a value that goes stale.
      return {
        ...result,
        todos: result.todos.map((todo) => service.annotateLinks(todo)).map((todo) => ({
          ...todo,
          sessionAlive: dispatcher.sessionAlive(todo.sessionId),
          sessionDir: dispatcher.sessionDir(todo.sessionId),
        })),
      }
    }),

    /**
     * List subdirectories, so the panel can offer a real folder picker.
     *
     * DSH 0.2.1 mounts its own directory picker, and the panel opens that one first; this
     * route is the independent path for a deployment that leaves it out, where the shell's
     * `uiWorkspace.pickDirectory()` throws instead of opening anything. A plugin cannot open
     * a native dialog from a page, but the Host can read directories — so the panel gets a
     * browser it can rely on either way.
     */
    exact('GET', `${ROUTE_BASE}/dirs`, async (request) => {
      const asked = (params(request).get('path') ?? '').trim()
      let base = asked
      if (base === '') {
        // No machine-local path here on purpose: this file ships, and the repository's own
        // check refuses those. A deployment that wants a specific starting point sets
        // `browseRoot`; the panel normally passes the current conversation's directory anyway.
        const candidates = [config?.browseRoot, homedir(), process.cwd()]
        for (const candidate of candidates) {
          if (typeof candidate !== 'string' || candidate === '') continue
          const info = await stat(candidate).catch(() => undefined)
          if (info?.isDirectory() === true) {
            base = candidate
            break
          }
        }
      }
      if (base === '') throw new TodoError('invalid-body', '没有可浏览的目录')
      if (path.isAbsolute(base) !== true) throw new TodoError('invalid-body', '需要一个绝对路径')
      const info = await stat(base).catch(() => undefined)
      if (info === undefined || info.isDirectory() !== true) throw new TodoError('not-found', `不是目录：${base}`)
      const entries = await readdir(base, { withFileTypes: true })
      const dirs = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('.') !== true)
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 200)
      const parent = path.dirname(base)
      return {
        path: base,
        parent: parent === base ? '' : parent,
        dirs: dirs.map((name) => ({ name, path: path.join(base, name) })),
        truncated: dirs.length >= 200,
      }
    }),

    exact('GET', `${ROUTE_BASE}/get`, async (request) => {
      const id = params(request).get('id') ?? ''
      return { todo: service.annotateLinks(await service.get(id)) }
    }),

    /**
     * What a bound conversation last said, plus whether it is still around.
     *
     * Deliberately a separate route: the list is polled and a hand-off's tail is not,
     * so folding this into /list would read every session on every poll. A missing
     * tail is the normal answer for a conversation this process has not seen speak.
     */
    exact('GET', `${ROUTE_BASE}/session`, async (request) => {
      const id = params(request).get('id') ?? ''
      if (id === '') return { session: null }
      const tailOf = typeof deps.sessionTail === 'function' ? deps.sessionTail : () => null
      let alive = false
      let dir = ''
      try {
        alive = dispatcher?.sessionAlive?.(id) === true
        dir = dispatcher?.sessionDir?.(id) ?? ''
      } catch {
        /* a missing dispatcher is not an error here */
      }
      return { session: { id, alive, dir, tail: tailOf(id) } }
    }),

    /**
     * The whole list as JSON.
     *
     * This is the store's own document, not the annotated `/list` shape: an export
     * is something `/import` has to be able to hand back unchanged.
     */
    exact('GET', `${ROUTE_BASE}/export`, async (request) => {
      const doc = await service.exportDocument()
      // `format=md` is for people and repositories: it diffs, it renders, it can be edited
      // by hand. The JSON document stays the round-trip format.
      if ((params(request).get('format') ?? '') === 'md') {
        return { markdown: toMarkdown(doc), count: doc.todos.length, exportedAt: new Date().toISOString() }
      }
      return { doc, count: doc.todos.length, exportedAt: new Date().toISOString() }
    }),

    /**
     * Load an exported document back into the list.
     *
     * `mode: 'merge'` (what the panel sends) updates by id and appends what is new;
     * the default `replace` makes the list exactly the document. A document with an
     * unreadable record is refused whole — a partial import is a silent loss.
     */
    exact('POST', `${ROUTE_BASE}/import`, async (request) => {
      const body = await readJsonBody(request)
      if (typeof body.markdown === 'string') {
        // Markdown has no ids, so it is not a document restore: it is a list of items to
        // add. Going through `create` means one validation path, honest ids, and a file
        // can never silently overwrite a record that happened to share an id.
        const parsed = fromMarkdown(body.markdown).todos
        if (parsed.length === 0) throw new TodoError('invalid-body', '这份 Markdown 里没有可识别的待办（- [ ] 标题）')
        const created = []
        for (const item of parsed) created.push(await service.create(item, { by: 'human' }))
        return { mode: 'markdown', imported: created.length, todos: created }
      }
      return service.importDocument(body.doc ?? body, { mode: body.mode, dryRun: body.dryRun === true })
    }),

    /**
     * What the agents finished in the last N days, and what it touched.
     *
     * Derived, never stored: completion records already hold the facts, and a cached
     * aggregate would be a second truth to keep honest.
     */

    /**
     * Serve the bytes of an image attachment.
     *
     * The path comes from the store, never from the request: the caller names a todo and
     * a link index, so there is no traversal surface here. The list still stores only a
     * reference; this route reads the file when the panel needs a thumbnail.
     */
    exact('GET', `${ROUTE_BASE}/asset`, async (request, response) => {
      const query = params(request)
      const id = (query.get('id') ?? '').trim()
      const index = Number.parseInt(query.get('index') ?? '', 10)
      if (id === '' || !Number.isInteger(index) || index < 0) {
        throw new TodoError('invalid-body', 'asset 需要 id 与 index')
      }
      const todo = await service.get(id)
      const link = (todo.links ?? [])[index]
      if (link === undefined) throw new TodoError('not-found', '这条待办没有这个附件')
      if (link.kind !== 'image') throw new TodoError('invalid-link', '只有图片附件可以这样读取')
      const info = await stat(link.value).catch(() => null)
      if (info === null || info.isFile() !== true) throw new TodoError('not-found', '图片不在了')
      if (info.size > MAX_ASSET_BYTES) {
        throw new TodoError('payload-too-large', `图片超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB`)
      }
      const bytes = await readFile(link.value)
      response.statusCode = 200
      response.setHeader('content-type', mimeForImage(link.value))
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      response.end(bytes)
    }),

    exact('GET', `${ROUTE_BASE}/report`, async (request) => {
      const days = Number.parseInt(params(request).get('days') ?? '', 10)
      const todos = await service.listAll()
      return { report: weeklyReport(todos, { days: Number.isFinite(days) ? days : 7 }) }
    }),

    exact('GET', `${ROUTE_BASE}/health`, async () => {
      // Counted once: the size feeds the metrics snapshot and the counts the panel
      // reads are the same numbers, so /health cannot contradict itself.
      const counts = await service.stats()
      // Where the automatic-collect switch came from. `false` because nobody turned it on
      // and `false` because the file is unreadable look identical from the panel, and the
      // second one used to be invisible everywhere.
      const settingsInfo = deps.settings?.info?.() ?? { file: '', at: 0, source: 'default', error: null }
      return {
        plugin: 'dsh-global-todo',
        version,
        // `version` is what this process runs; `packageVersion` is what is installed. After
        // an upgrade the two differ until the host restarts, and the panel then calls routes
        // the old graph does not have (a 404 that looks like a plugin bug).
        packageVersion: deps.diskVersion ?? version,
        stale: deps.diskVersion !== undefined && deps.diskVersion !== version,
        store: await service.describe(),
        // Multi-machine: whether a share is configured, and how the last attempt went. Absent
        // means this build has no sync at all; `configured: false` means on purpose.
        sync: deps.sync?.describe?.() ?? { configured: false },
        counts,
        // The count says something waits for a person; the items say what, so a check does not
        // have to drive the UI to find out.
        review: { count: counts.review, items: await service.awaitingReview() },
        // Purely additive, in-memory counters: hand-off success rate, agent tool
        // calls and how the list grew. `null` when they were never mounted — an
        // absent metric is not a zero.
        metrics: deps.metrics?.snapshot?.({ size: counts.total }) ?? null,
        dispatch: dispatcher.capabilities(),
        // Tool registration is the surface that fails quietly, so it is reported
        // rather than assumed.
        tools: deps.tools ?? { registered: [], error: null },
        // Which optional surfaces this deployment has. The panel hides entries it cannot
        // call, and a check can tell "switched off" (mode/registered) from "failed"
        // (tools.error above). Absent on an older host → assume everything is on.
        modules: deps.modulesInfo?.() ?? { toolGroups: 'all', registered: [], capture: true },
        // Automatic completion is the other surface that can fail quietly: if the
        // session watcher did not attach, the only symptom would be todos that
        // never finish themselves.
        completion: {
          watching: deps.completion?.watching === true,
          autoMarksDone: deps.completion?.watching === true,
          error: deps.completion?.error ?? null,
        },
        // The automatic collect switch lives on the Host (the panel may be closed),
        // so the panel reads it here and writes it through `/settings`.
        // Which fence is actually in force, because the fallback is stricter than the
        // Host's own trusted-host list — a silent downgrade here breaks the panel for
        // every non-loopback browser while /health still looks healthy.
        // The panel's own error reports, newest first: the only way to see what a
        // browser on the other side of the LAN actually got.
        clientErrors: deps.diagnostics?.recent?.() ?? [],
        fence: {
          host: fenceOf() !== undefined && fenceOf() !== null,
          loopbackFallback: fenceOf() === undefined || fenceOf() === null,
          // Local scripts (no cookie, no Origin) are admitted by the loopback rule even
          // when the fence is installed; browsers always go through the fence.
          localScriptsAdmitted: true,
        },
        settings: {
          autoCollect: deps.settings?.get?.().autoCollect === true,
          // Reported because the rule in force must be observable: without this, a check
          // cannot tell whether the idle gate is deployed at all.
          idleMinutes: deps.settings?.get?.().idleMinutes ?? 30,
          cooldownMinutes: deps.settings?.get?.().cooldownMinutes ?? 30,
          // Shown and edited by the panel; the capture tool reads the same value when it
          // decides whether a candidate is worth registering at all.
          captureMinWeight: deps.settings?.get?.().captureMinWeight ?? 0.35,
          // The exempted workspaces, so the panel can show which conversations are out of
          // scope instead of leaving the person to guess why nothing was ever asked.
          exemptWorkspaces: deps.settings?.get?.().exemptWorkspaces ?? [],
          // Reported so "off" can be told apart from "the file did not load".
          file: settingsInfo.file,
          loadedAt: settingsInfo.at,
          loadSource: settingsInfo.source,
          loadError: settingsInfo.error,
          // The token itself never leaves the settings file; the panel only needs to know
          // whether one is set before it can usefully show the ingest section.
          remindersEnabled: deps.settings?.get?.().remindersEnabled !== false,
          reminderLeadMinutes: deps.settings?.get?.().reminderLeadMinutes ?? 0,
          // Multi-machine: the panel edits these and the sync reads the same values. A path
          // rather than a flag, because the share differs per machine.
          syncDir: deps.settings?.get?.().syncDir ?? '',
          syncMinutes: deps.settings?.get?.().syncMinutes ?? 5,
          ingest: {
            enabled: deps.settings?.get?.().ingestEnabled === true,
            sources: deps.settings?.get?.().ingestSources ?? [],
            confirmBelow: deps.settings?.get?.().ingestConfirmBelow ?? 0.8,
            tokenSet: typeof deps.settings?.get?.().ingestToken === 'string' && deps.settings.get().ingestToken !== '',
          },
        },
        autoCollect: {
          // Derived from the setting, not from a copy kept elsewhere: two sources for one
          // fact is how `/health` ends up contradicting itself.
          enabled: deps.settings?.get?.().autoCollect === true,
          asking: deps.autoCollect?.asking === true,
          lastAsk: deps.autoCollect?.lastAsk ?? null,
          error: deps.autoCollect?.error ?? null,
          // Why a conversation was or was not asked. The decision used to keep the reason
          // in a local and drop it, so this question had no answer even in the Host.
          waiting: deps.autoCollect?.waiting ?? 0,
          due: deps.autoCollect?.due ?? 0,
          lastDecision: deps.autoCollect?.lastDecision ?? null,
          decisions: deps.autoCollect?.decisions ?? [],
          stats: deps.autoCollect?.stats ?? { asked: 0, succeeded: 0, failed: 0, dropped: 0 },
          // Set after a failed question, so a retry in flight is visible rather than
          // looking like the feature silently stopped.
          lastRetry: deps.autoCollect?.lastRetry ?? null,
          lastDrop: deps.autoCollect?.lastDrop ?? null,
        },
        // Deadlines that passed and have not been acknowledged. In memory: the host
        // announces once, the panel acknowledges, a restart re-announces unacknowledged ones.
        reminders: { due: deps.reminders?.due ?? [] },
        // 「交给 Agent」 resolves its target from the conversation the user last
        // wrote in, so whether that feed attached is worth reporting too.
        target: {
          trackingRecent: deps.target?.watching === true,
          recentSessionId: typeof deps.target?.id === 'string' ? deps.target.id : '',
        },
      }
    }),

    // GET reports what this host can do; POST folds with the shared directory. One
    // registration for both, because the Host's table is keyed by path (see `verbs`).
    verbs(['GET', 'POST'], `${ROUTE_BASE}/sync`, async (request) => {
      if (request.method === 'GET') return deps.sync?.describe?.() ?? { configured: false }
      if (deps.sync === undefined) throw new TodoError('sync-not-configured', '这个版本没有多端同步')
      // A sync is a write to a network share; a request without a body is a plain "sync now".
      const body = await readJsonBody(request).catch(() => ({}))
      return deps.sync.run({ dryRun: body?.dryRun === true })
    }),

    exact('POST', `${ROUTE_BASE}/diagnostics`, async (request) => {
      const body = await readJsonBody(request)
      // `scope` is the grouping key in /health; without it every entry collapses into one
      // nameless bucket, so it is required rather than defaulted.
      if (typeof body.scope !== 'string' || body.scope.trim() === '') {
        throw new TodoError('invalid-body', 'diagnostics 需要 scope（如 health / list / dispatch）')
      }
      // The panel's failures happen in someone else's browser, where neither the Host
      // nor the person wants to be reading consoles. Reporting them here is what makes
      // "click it and tell me what it said" unnecessary.
      const entry = deps.diagnostics?.record?.(body) ?? null
      return { recorded: entry !== null }
    }),

    exact('POST', `${ROUTE_BASE}/settings`, async (request) => {
      const body = await readJsonBody(request)
      // The settings store clamps silently, which is right for a hand-edited file and wrong
      // for an API: `{idleMinutes: -5}` answering 200-but-5 hides the rejected intent. A
      // provided value outside its range is reported instead.
      assertSettingsShape(body ?? {})
      assertSettingsRange(body ?? {})
      const next = await deps.settings.update(body ?? {})
      return {
        settings: {
          autoCollect: next.autoCollect,
          idleMinutes: next.idleMinutes,
          cooldownMinutes: next.cooldownMinutes,
          exemptWorkspaces: next.exemptWorkspaces,
          ingest: {
            enabled: next.ingestEnabled,
            sources: next.ingestSources,
            confirmBelow: next.ingestConfirmBelow,
            tokenSet: next.ingestToken !== '',
          },
          syncDir: next.syncDir,
          syncMinutes: next.syncMinutes,
        },
      }
    }),

    exact('POST', `${ROUTE_BASE}/reminders/ack`, async (request) => {
      const body = await readJsonBody(request)
      const ids = new Set(
        Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id !== '') : [],
      )
      const state = deps.reminders
      if (state !== undefined && state !== null && Array.isArray(state.due)) {
        state.due = state.due.filter((item) => !ids.has(item.id))
      }
      return { cleared: ids.size }
    }),

    exact('POST', `${ROUTE_BASE}/ingest`, async (request) => {
      const settings = deps.settings?.get?.()
      if (settings?.ingestEnabled !== true) {
        throw new TodoError('forbidden', '外部 ingest 未开启（settings.ingestEnabled）')
      }
      const expected = typeof settings.ingestToken === 'string' ? settings.ingestToken : ''
      const header = typeof request.headers.authorization === 'string' ? request.headers.authorization : ''
      const match = /^Bearer\s+(.+)$/i.exec(header)
      const supplied = match === null ? '' : match[1].trim()
      // Hash both sides so the comparison is constant-time regardless of the token's length;
      // an empty expected token refuses every request rather than matching an empty one.
      const equal =
        expected !== '' &&
        supplied !== '' &&
        timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest())
      if (!equal) throw new TodoError('unauthorized', 'ingest token 不正确')
      const body = await readJsonBody(request)
      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new TodoError('invalid-body', 'items 必须是非空数组')
      }
      if (body.items.length > MAX_INGEST_ITEMS) {
        throw new TodoError('invalid-body', `一次最多 ${MAX_INGEST_ITEMS} 条`)
      }
      const result = await service.ingest(body.items, {
        confirmBelow: settings.ingestConfirmBelow,
        dryRun: body.dryRun === true,
      })
      return {
        dryRun: body.dryRun === true,
        accepted: result.created.length,
        created: result.created,
        skipped: result.skipped,
        preview: result.preview,
      }
    }),

    exact('POST', `${ROUTE_BASE}/assign`, async (request) => {
      const body = await readJsonBody(request)
      return dispatcher.assignMany(body ?? {})
    }),

    exact('POST', `${ROUTE_BASE}/bulk`, async (request) => {
      const body = await readJsonBody(request)
      return service.bulk(
        body.ids,
        { status: body.status, addTags: body.addTags, removeTags: body.removeTags },
        { by: actorOf(body) },
      )
    }),

    exact('POST', `${ROUTE_BASE}/capture`, async (request) => {
      const body = await readJsonBody(request)
      // A person clicked: the wording may err towards completeness.
      return dispatcher.requestCapture({ ...(body ?? {}), mode: 'manual' })
    }),

    exact('POST', `${ROUTE_BASE}/note`, async (request) => {
      const body = await readJsonBody(request)
      // A note with no text records an empty entry in the activity trail: the README calls
      // `text` required, so an empty one is a bad body, not a note.
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        throw new TodoError('invalid-body', 'note 需要非空的 text')
      }
      const { todo, note } = await service.note(body.id, body.text, { by: 'human' })
      return { todo, note }
    }),

    exact('POST', `${ROUTE_BASE}/create`, async (request) => {
      const body = await readJsonBody(request)
      // The panel's own form: the person typed it, so no gate applies and the level they chose
      // (or the 常规 default) is theirs to keep.
      return { todo: await service.create(body, { by: 'human', source: 'human' }) }
    }),

    exact('POST', `${ROUTE_BASE}/update`, async (request) => {
      const body = await readJsonBody(request)
      const by = actorOf(body)
      const { id, ...patch } = body
      // `by` is a statement about the caller, not a field of the record.
      delete patch.by
      return service.update(id, patch, { by })
    }),

    exact('POST', `${ROUTE_BASE}/status`, async (request) => {
      const body = await readJsonBody(request)
      const by = actorOf(body)
      return { todo: await service.setStatus(body.id, body.status ?? 'done', { by }) }
    }),

    // Answering the mark an agent's completion leaves behind: confirm, or send it back.
    exact('POST', `${ROUTE_BASE}/review`, async (request) => {
      const body = await readJsonBody(request)
      return { todo: await service.review(body.id, body.decision ?? 'confirm', { by: 'human', reason: body.reason }) }
    }),

    exact('POST', `${ROUTE_BASE}/remove`, async (request) => {
      const body = await readJsonBody(request)
      return { todo: await service.remove(body.id, { by: 'human' }) }
    }),

    exact('POST', `${ROUTE_BASE}/relink`, async (request) => {
      // Re-pointing a dead attachment: the byte-free equivalent of "upload it again".
      const body = await readJsonBody(request)
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw new TodoError('invalid-body', 'relink 需要 id')
      }
      const index = Number(body.index)
      if (!Number.isInteger(index) || index < 0) {
        throw new TodoError('invalid-body', 'relink 需要 index（附件在列表里的位置）')
      }
      const todo = await service.get(body.id)
      const link = (todo.links ?? [])[index]
      if (link === undefined) throw new TodoError('not-found', '这条待办没有这个附件')
      if (typeof body.value !== 'string' || body.value.trim() === '') {
        throw new TodoError('invalid-body', 'relink 需要新的 value（绝对路径或网址）')
      }
      const links = todo.links.slice()
      links[index] = { kind: link.kind, value: body.value.trim(), ...(link.title === '' ? {} : { title: link.title }) }
      // Same shape as /update: the service already answers `{ todo, changed }`.
      return service.update(body.id, { links }, { by: 'human' })
    }),

    exact('POST', `${ROUTE_BASE}/restore`, async (request) => {
      // The panel's undo: put a removed record back verbatim, timestamps and
      // attachments included, instead of re-creating it as a new todo.
      const body = await readJsonBody(request)
      // A partial object would be "restored" with invented defaults (a new createdAt, empty
      // tags, a reassigned seq) — a lossy success is worse than a refusal.
      const todo = body.todo
      if (todo === null || typeof todo !== 'object' || Array.isArray(todo)) {
        throw new TodoError('invalid-body', 'restore 需要完整的 todo 对象')
      }
      for (const field of ['id', 'title', 'createdAt', 'status']) {
        if (todo[field] === undefined || todo[field] === null || todo[field] === '') {
          throw new TodoError('invalid-body', `restore 的 todo 缺少 ${field}；撤销要原样放回，不能补默认值`)
        }
      }
      return { todo: await service.restore(todo, { by: 'human' }) }
    }),

    exact('POST', `${ROUTE_BASE}/link`, async (request) => {
      const body = await readJsonBody(request)
      const id = body.id
      const additions = Array.isArray(body.add) ? body.add : []
      const removals = Array.isArray(body.remove) ? body.remove : []
      let todo = await service.get(id)
      let added = 0
      let removed = 0
      for (const item of additions) {
        const result = await service.addLink(id, item, { by: 'human' })
        todo = result.todo
        if (result.added) added += 1
      }
      for (const item of removals) {
        let ref
        if (Number.isInteger(item)) {
          ref = { index: item }
        } else {
          // Accept the attachment's value or its rendered title, so the panel
          // never has to know the internal key format.
          const wanted = String(item)
          const match = todo.links.find((link) => link.value === wanted || link.title === wanted)
          if (match === undefined) continue
          ref = { key: `${match.kind}\u0000${match.value}` }
        }
        const result = await service.removeLink(id, ref, { by: 'human' })
        todo = result.todo
        if (result.removed !== null) removed += 1
      }
      return { todo, added, removed }
    }),

    exact('POST', `${ROUTE_BASE}/dispatch`, async (request) => {
      const body = await readJsonBody(request)
      // A missing id is a malformed request (400), not a record that does not exist (404).
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw new TodoError('invalid-body', 'dispatch 需要 id')
      }
      return dispatcher.dispatch(body.id, {
        mode: body.mode,
        sessionId: body.sessionId,
        dir: body.dir,
        // Load-bearing: without this the dispatcher treats an explicit pick as a
        // guess and may substitute another conversation. It was dropped here once,
        // which made 「选了之后还是交给别人」 survive a fix that was otherwise
        // complete.
        authoritative: body.authoritative === true,
        // Which workspace a NEW conversation should join; empty means "the one
        // that owns the conversation this todo came from".
        workspaceId: body.workspaceId,
      })
    }),
  ]
}

/**
 * Types the settings route insists on, because the store coerces instead of rejecting.
 *
 * \`normalizeSettings\` is written for a hand-edited file: \`autoCollect: "true"\` becomes
 * false, an unknown source is dropped, a typo silently changes nothing. That is the right
 * behaviour when reading a file and the wrong behaviour for a request.
 *
 * @param {Record<string, unknown>} body
 */
function assertSettingsShape(body) {
  const known = ['autoCollect', 'idleMinutes', 'cooldownMinutes', 'exemptWorkspaces', 'ingestEnabled', 'ingestSources', 'ingestConfirmBelow', 'ingestToken', 'remindersEnabled', 'reminderLeadMinutes', 'captureMinWeight', 'syncDir', 'syncMinutes']
  for (const key of Object.keys(body)) {
    if (!known.includes(key)) {
      throw new TodoError('invalid-body', '未知的设置项 ' + key + '；可写的是 ' + known.join(' / '))
    }
  }
  for (const field of ['autoCollect', 'ingestEnabled', 'remindersEnabled']) {
    const value = body[field]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TodoError('invalid-body', field + ' 必须是 true / false，收到 ' + JSON.stringify(value))
    }
  }
  if (body.ingestToken !== undefined && typeof body.ingestToken !== 'string') {
    throw new TodoError('invalid-body', 'ingestToken 必须是字符串')
  }
  if (body.syncDir !== undefined) {
    if (typeof body.syncDir !== 'string') throw new TodoError('invalid-body', 'syncDir 必须是字符串')
    // The normalizer drops a path it cannot use; an API answering 200 while keeping the old
    // directory is the "saved but nothing changed" failure this route exists to avoid.
    if (body.syncDir.trim() !== '' && normalizeSyncDir(body.syncDir) === '') {
      throw new TodoError('invalid-body', `syncDir 必须是绝对路径，收到 ${JSON.stringify(body.syncDir)}`)
    }
  }
  if (body.exemptWorkspaces !== undefined) {
    if (!Array.isArray(body.exemptWorkspaces) || body.exemptWorkspaces.some((entry) => typeof entry !== 'string')) {
      throw new TodoError('invalid-body', 'exemptWorkspaces 必须是字符串数组')
    }
  }
  if (body.ingestSources !== undefined) {
    if (!Array.isArray(body.ingestSources)) {
      throw new TodoError('invalid-body', 'ingestSources 必须是数组')
    }
    const bad = body.ingestSources.filter((entry) => typeof entry !== 'string' || !INGEST_SOURCES.includes(entry))
    if (bad.length > 0) {
      throw new TodoError('invalid-body', 'ingestSources 只能是 ' + INGEST_SOURCES.join(' / ') + '，收到 ' + bad.join(', '))
    }
  }
}

/**
 * Ranges the settings route refuses, mirroring the clamps in `normalizeSettings`.
 *
 * @param {Record<string, unknown>} body
 */
function assertSettingsRange(body) {
  const ranges = {
    idleMinutes: [5, 24 * 60, true],
    cooldownMinutes: [5, 24 * 60, true],
    ingestConfirmBelow: [0, 1, false],
    reminderLeadMinutes: [0, 24 * 60, true],
    captureMinWeight: [0, 1, false],
    // 0 is meaningful here ("only when asked"), so the range starts at zero rather than one.
    syncMinutes: [0, 24 * 60, true],
  }
  for (const [field, [low, high, whole]] of Object.entries(ranges)) {
    const value = body[field]
    if (value === undefined) continue
    // `null` used to fall through to the clamp: `Number(null) === 0`, so a null weight
    // became 0 and turned the whole capture gate off while answering 200. A field that is
    // present but null is a bad body, like every other non-number here.
    if (value === null) {
      throw new TodoError('invalid-body', `${field} 不能是 null；要恢复默认就从请求里省略它`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TodoError('invalid-body', `${field} 必须是数字（${low}–${high}）`)
    }
    // The weight is a two-decimal number by contract; storing 0.345 as 0.35 is the same
    // silent adjustment that a fractional minute is rejected for.
    if (field === 'captureMinWeight' && Math.round(value * 100) / 100 !== value) {
      throw new TodoError('invalid-body', 'captureMinWeight 最多两位小数，收到 ' + String(value))
    }
    // normalizeSettings only accepts integers for the minute fields and otherwise falls back
    // to the default — a silently ignored 30.5 is the same trap as a silent clamp.
    if (whole === true && !Number.isInteger(value)) {
      throw new TodoError('invalid-body', `${field} 必须是整数分钟，收到 ${value}`)
    }
    if (value < low || value > high) {
      throw new TodoError('invalid-body', `${field} 必须在 ${low}–${high} 之间，收到 ${value}`)
    }
  }
}
export { sendJson, readJsonBody }
