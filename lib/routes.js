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

import { TodoError, asTodoError } from './errors.js'

/** Route prefix. The client appends this to the document base. */
export const ROUTE_BASE = '/api/global-todo'

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Only requests from this machine's own pages may touch the list.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
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
  if (code === 'forbidden') return 403
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
 * @param {string} deps.version
 * @returns {Array<{ kind: string, path: string, handler: Function }>}
 */
export function createRoutes(deps) {
  const { service, dispatcher, version } = deps
  const logger = deps.logger
  const connection = deps.connection

  /**
   * @param {Function} handler
   * @returns {Function} a fenced handler
   */
  function route(handler) {
    return async (request, response) => {
      try {
        let rejection
        try {
          rejection = connection?.requestRejection?.(request)
        } catch (error) {
          logger?.warn?.(`dsh-global-todo: connection 围栏异常：${error?.message ?? error}`)
          rejection = 403
        }
        if (typeof rejection === 'number') {
          sendJson(response, rejection, { ok: false, reason: 'forbidden', error: '请求被宿主连接围栏拒绝' })
          return
        }
        if (rejection !== undefined && rejection !== null) {
          sendJson(response, 403, { ok: false, reason: 'forbidden', error: '请求被宿主连接围栏拒绝' })
          return
        }
        if (connection === undefined && !isLoopbackRequest(request)) {
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

  /** @param {import('node:http').IncomingMessage} request */
  const params = (request) => new URL(request.url ?? ROUTE_BASE, 'http://localhost').searchParams

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
        todos: result.todos.map((todo) => ({
          ...todo,
          sessionAlive: dispatcher.sessionAlive(todo.sessionId),
          sessionDir: dispatcher.sessionDir(todo.sessionId),
        })),
      }
    }),

    exact('GET', `${ROUTE_BASE}/get`, async (request) => {
      const id = params(request).get('id') ?? ''
      return { todo: await service.get(id) }
    }),

    exact('GET', `${ROUTE_BASE}/health`, async () => ({
      plugin: 'dsh-global-todo',
      version,
      store: await service.describe(),
      counts: await service.stats(),
      dispatch: dispatcher.capabilities(),
      // Tool registration is the surface that fails quietly, so it is reported
      // rather than assumed.
      tools: deps.tools ?? { registered: [], error: null },
      // Automatic completion is the other surface that can fail quietly: if the
      // session watcher did not attach, the only symptom would be todos that
      // never finish themselves.
      completion: {
        watching: deps.completion?.watching === true,
        autoMarksDone: deps.completion?.watching === true,
        error: deps.completion?.error ?? null,
      },
      // 「交给 Agent」 resolves its target from the conversation the user last
      // wrote in, so whether that feed attached is worth reporting too.
      target: {
        trackingRecent: deps.target?.watching === true,
        recentSessionId: typeof deps.target?.id === 'string' ? deps.target.id : '',
      },
    })),

    exact('POST', `${ROUTE_BASE}/capture`, async (request) => {
      const body = await readJsonBody(request)
      return dispatcher.requestCapture(body ?? {})
    }),

    exact('POST', `${ROUTE_BASE}/create`, async (request) => {
      const body = await readJsonBody(request)
      return { todo: await service.create(body, { by: 'human' }) }
    }),

    exact('POST', `${ROUTE_BASE}/update`, async (request) => {
      const body = await readJsonBody(request)
      const { id, ...patch } = body
      return service.update(id, patch, { by: 'human' })
    }),

    exact('POST', `${ROUTE_BASE}/status`, async (request) => {
      const body = await readJsonBody(request)
      return { todo: await service.setStatus(body.id, body.status ?? 'done', { by: 'human' }) }
    }),

    exact('POST', `${ROUTE_BASE}/remove`, async (request) => {
      const body = await readJsonBody(request)
      return { todo: await service.remove(body.id, { by: 'human' }) }
    }),

    exact('POST', `${ROUTE_BASE}/restore`, async (request) => {
      // The panel's undo: put a removed record back verbatim, timestamps and
      // attachments included, instead of re-creating it as a new todo.
      const body = await readJsonBody(request)
      return { todo: await service.restore(body.todo, { by: 'human' }) }
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
      return dispatcher.dispatch(body.id, {
        mode: body.mode,
        sessionId: body.sessionId,
        dir: body.dir,
      })
    }),
  ]
}

export { sendJson, readJsonBody }
