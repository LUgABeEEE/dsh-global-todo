/**
 * Hand-off: turn a todo into work an agent session actually does.
 *
 * Three modes, because "continue this" means different things at different
 * times:
 *
 *  - `bound`   — send it to the session this todo already owns. Repeat hand-offs
 *                land in the same conversation, so the agent keeps its context.
 *  - `new`     — create a fresh, fully composed session (agent preset mounted,
 *                grouped into the workspace that owns the target directory) and
 *                send the todo there.
 *  - `current` — send it to the session the human is looking at right now.
 *  - `auto`    — `bound` when that session is still alive, otherwise `new`.
 *                This is what the panel's ▶ button uses.
 *
 * The session is created through `ctx.root`, not through this plugin's own
 * fiber: the agent is then owned by the application, so disabling, updating or
 * removing this plugin row does not tear down work it started.
 *
 * Every attempt — success or failure — is recorded on the todo. A hand-off that
 * silently failed is worse than one that never happened, so a failure keeps its
 * reason on the record and the panel shows it.
 *
 * @module dsh-global-todo/dispatch
 */

import { randomUUID } from 'node:crypto'

import { TodoError, asTodoError } from './errors.js'

const PLUGIN_SOURCE = 'plugin:dsh-global-todo'

/** Modes accepted by {@link createDispatcher}. */
export const DISPATCH_MODES = Object.freeze(['auto', 'bound', 'new', 'current'])

/**
 * The message block a session receives.
 *
 * `content` must be an array of content blocks: a bare string corrupts the
 * session record, and this is a plugin-authored user turn, not a chat message.
 *
 * @param {string} prompt
 * @param {string} summary
 * @returns {object}
 */
function noticeMessage(prompt, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: PLUGIN_SOURCE, form: 'notice', summary },
  }
}

/**
 * @param {{ ctx: object, service: object, config?: object, logger?: object }} options
 */
export function createDispatcher(options) {
  const ctx = options.ctx
  const service = options.service
  const config = options.config ?? {}
  const logger = options.logger
  // Called after a hand-off actually went out, so the completion watcher knows
  // which session it is allowed to close.
  const onDispatched = typeof options.onDispatched === 'function' ? options.onDispatched : undefined
  // The conversation the user most recently wrote in. The panel cannot always
  // see which conversation is on screen (this panel *is* the main view), so the
  // Host tracks activity and answers here instead.
  const getRecentSession = typeof options.getRecentSession === 'function' ? options.getRecentSession : undefined

  const log = (level, message, error) => {
    const sink = logger?.[level]
    if (typeof sink === 'function') sink.call(logger, `dsh-global-todo: ${message}`, error ?? '')
  }

  /** @returns {object} the root context; the plugin's own fiber is not enough */
  function rootCtx() {
    return ctx?.root ?? ctx
  }

  /** @returns {object | undefined} */
  function agents() {
    const root = rootCtx()
    const service_ = root?.get?.('agents')
    return service_ === undefined || service_ === null ? undefined : service_
  }

  /** @returns {Record<string, boolean>} which optional services this Host has */
  function capabilities() {
    const root = rootCtx()
    const has = (name) => {
      try {
        return root?.get?.(name) !== undefined
      } catch {
        return false
      }
    }
    return {
      agents: has('agents'),
      agentPresets: has('agentPresets'),
      agentDefaultModel: has('agentDefaultModel'),
      workspaceRegistry: has('workspaceRegistry'),
    }
  }

  /**
   * @param {object | undefined} source
   * @returns {{ provider?: string, model?: string } | undefined}
   */
  function modelSelection(source) {
    if (source?.options !== undefined) {
      const { provider, model } = source.options
      if (typeof provider === 'string' || typeof model === 'string') return { provider, model }
    }
    try {
      const defaults = rootCtx()?.get?.('agentDefaultModel')
      const selection = defaults?.currentSelection?.()
      if (selection !== null && typeof selection === 'object') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* fall through to the harness default */
    }
    return undefined
  }

  /**
   * Group a freshly created session under the workspace that owns its
   * directory. Cosmetic: a failure here must not cost the session.
   *
   * @param {string} sessionId
   * @param {string} dirPath
   * @returns {Promise<string>}
   */
  async function attachToWorkspace(sessionId, dirPath) {
    if (dirPath === '') return 'no-dir'
    const registry = rootCtx()?.get?.('workspaceRegistry')
    if (registry === undefined || registry === null) return 'no-service'
    try {
      let workspace = await registry.resolveByPath(dirPath)
      if (workspace === undefined) workspace = await registry.create(dirPath)
      if (typeof workspace?.attachSession === 'function') await workspace.attachSession(sessionId)
      return 'attached'
    } catch (error) {
      log('warn', `新会话未能归入工作区（session=${sessionId}）`, error)
      return 'failed'
    }
  }

  /**
   * Create a composed session and hand it the todo.
   *
   * @param {object} todo
   * @param {{ dir?: string, sourceSessionId?: string }} context
   * @returns {Promise<string>} the new session id
   */
  async function spawnSession(todo, context) {
    const store = agents()
    if (store === undefined) {
      throw new TodoError('agents-unavailable', '这个宿主没有 agents 服务，无法新建会话')
    }
    const dir = typeof context.dir === 'string' ? context.dir.trim() : ''
    if (dir === '') {
      throw new TodoError(
        'dispatch-failed',
        '这条待办没有工作目录，开新会话会落到 Host 的 _no-cwd 里（agent 在那里做不了事）。'
          + '在面板上点「工作目录 → 选择」，或在这条待办上写明目录后重派。',
      )
    }
    const meta = { cwd: dir }

    let setup
    const presets = rootCtx()?.get?.('agentPresets')
    if (presets !== undefined && presets !== null) {
      try {
        const source = context.sourceSessionId === undefined ? undefined : store.get(context.sourceSessionId)
        const sourcePreset = source?.session?.header?.agentPreset
        const resolved = await presets.resolve(sourcePreset)
        meta.agentPreset = resolved.id
        const presetId = resolved.id
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        }
      } catch (error) {
        throw new TodoError('dispatch-failed', `解析 agent preset 失败：${asTodoError(error).message}`)
      }
    }

    const sessionId = `session-${randomUUID()}`
    let handle
    try {
      handle = await store.create({
        sessionId,
        meta,
        agentOptions: modelSelection(undefined),
        ...(setup === undefined ? {} : { setup }),
      })
    } catch (error) {
      throw new TodoError('dispatch-failed', `新建会话失败：${asTodoError(error).message}`)
    }
    void attachToWorkspace(sessionId, dir)
    return { sessionId, agent: handle?.agent }
  }

  /**
   * Send the todo as a user turn.
   *
   * @param {object} target - a live agent
   * @param {string} prompt
   * @param {string} title
   */
  function sendTo(target, prompt, title) {
    const message = noticeMessage(prompt, `全局待办：${title}`)
    if (target.status === 'running' && typeof target.steer === 'function') {
      target.steer(message)
    } else if (typeof target.followup === 'function') {
      target.followup(message)
    } else {
      throw new TodoError('dispatch-failed', '目标会话不接受新的消息（followup 不可用）')
    }
  }

  /**
   * @param {object | undefined} target
   * @returns {string} a live session's working directory, or ''
   */
  function currentDirOf(target) {
    const cwd = target?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : ''
  }

  /**
   * The conversation "hand it to the agent" should mean.
   *
   * Order: what the caller named, the conversation the user last wrote in, then
   * the conversation this todo was written from. Each candidate must still exist
   * — a dead id is not a target.
   *
   * @param {object} input
   * @returns {string} a live session id, or '' when nothing can be resolved
   */
  function resolveCurrentSession(input) {
    const store = input.store
    const candidates = [input.requested, input.recent, input.todo?.originSessionId]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate === '') continue
      try {
        if (store.get(candidate) !== undefined) return candidate
      } catch {
        /* an unusable candidate is simply skipped */
      }
    }
    return ''
  }

  /**
   * Tell the completion watcher that this session now owes a finished turn.
   *
   * @param {Function | undefined} sink
   * @param {string} sessionId
   * @param {Function} log
   */
  function notify(sink, sessionId, log) {
    if (sink === undefined) return
    try {
      sink(sessionId)
    } catch (error) {
      log('warn', 'completion hook failed', error)
    }
  }

  /**
   * Where a brand-new session should start.
   *
   * Order of preference:
   *   1. what the caller asked for (the panel sends the conversation you are in);
   *   2. the directory the todo was written from;
   *   3. the working directory of the session this todo was handed to before;
   *   4. the configured `dispatchDir`.
   *
   * Returning `''` is a real answer — and the caller turns it into a refusal,
   * because a session without a working directory is a session where the agent
   * cannot do the work (it lands in the Host's `_no-cwd` bucket).
   *
   * @param {{ dir?: string, todo: object, bound?: object, config: object }} input
   * @returns {string}
   */
  function resolveDir(input) {
    const candidates = [
      input.dir,
      input.todo?.originDir,
      input.bound?.session?.header?.cwd,
      input.config?.dispatchDir,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return ''
  }

  /**
   * Hand one todo to a session.
   *
   * @param {string} id
   * @param {{ mode?: string, sessionId?: string, dir?: string }} [request]
   * @returns {Promise<{ todo: object, mode: string, sessionId: string, reused: boolean }>}
   */
  async function dispatch(id, request = {}) {
    const mode = typeof request.mode === 'string' && request.mode !== '' ? request.mode : 'auto'
    if (!DISPATCH_MODES.includes(mode)) {
      throw new TodoError('invalid-body', `派发模式只能是 ${DISPATCH_MODES.join(' / ')}，收到 ${mode}`)
    }

    const todo = await service.get(id)
    const prompt = service.dispatchPrompt(todo)
    const store = agents()
    const bound = todo.sessionId === '' || store === undefined ? undefined : store.get(todo.sessionId)
    const dir = resolveDir({ dir: request.dir, todo, bound, config })

    const fail = async (error, targetDir = dir) => {
      const wrapped = asTodoError(error, 'dispatch-failed')
      await service.recordDispatch(id, { mode, ok: false, error: wrapped.message, dir: targetDir })
      throw wrapped
    }

    if (store === undefined) {
      return fail(new TodoError('agents-unavailable', '这个宿主没有 agents 服务，无法把待办交给 Agent'))
    }

    try {
      if (mode === 'current') {
        const wanted = resolveCurrentSession({
          store,
          requested: typeof request.sessionId === 'string' ? request.sessionId : '',
          recent: getRecentSession?.(),
          todo,
        })
        if (wanted === '') {
          throw new TodoError(
            'dispatch-failed',
            '找不到「当前对话」：面板不知道你在哪个对话里，Host 也没看到你最近说过话。'
              + '先在任意对话里说一句，或改用「开新会话」。',
          )
        }
        const target = store.get(wanted)
        sendTo(target, prompt, todo.title)
        await service.recordDispatch(id, { mode, ok: true, sessionId: wanted, dir: target?.session?.header?.cwd ?? '' })
        notify(onDispatched, wanted, log)
        return { todo: await service.get(id), mode, sessionId: wanted, reused: true, dir: target?.session?.header?.cwd ?? '' }
      }

      // `auto` prefers the conversation this todo already owns, but falls back to
      // the conversation the user is in before opening yet another one: a second
      // click must not drag work away from the chat in front of them.
      const currentId = mode === 'auto' ? resolveCurrentSession({
        store,
        requested: typeof request.sessionId === 'string' ? request.sessionId : '',
        recent: getRecentSession?.(),
        todo,
      }) : ''
      // `auto` with nothing usable to fall back on hands the work to the
      // conversation the user is in, rather than opening a session they did not
      // ask for.
      const boundUsable = todo.sessionId !== '' && bound !== undefined && sessionDir(todo.sessionId) !== ''
      if (mode === 'auto' && boundUsable !== true && currentId !== '') {
        const currentTarget = store.get(currentId)
        sendTo(currentTarget, prompt, todo.title)
        await service.recordDispatch(id, { mode: 'current', ok: true, sessionId: currentId, dir: currentDirOf(currentTarget) })
        notify(onDispatched, currentId, log)
        return {
          todo: await service.get(id),
          mode: 'current',
          sessionId: currentId,
          reused: true,
          dir: currentDirOf(currentTarget),
        }
      }

      if (mode === 'bound' || (mode === 'auto' && todo.sessionId !== '')) {
        const wanted = mode === 'bound' && typeof request.sessionId === 'string' && request.sessionId !== ''
          ? request.sessionId
          : todo.sessionId
        const target = wanted === '' ? undefined : store.get(wanted)
        // For `auto`, a live conversation with no working directory is not a
        // usable target: reusing it reproduces exactly the failure this plugin
        // once created (an agent that cannot do the work). Treat it like a gone
        // session and open a fresh one in a directory we resolved instead.
        const unusable = mode === 'auto' && target !== undefined && sessionDir(wanted) === ''
        if (target === undefined || unusable) {
          if (mode === 'bound') {
            throw new TodoError(
              'dispatch-failed',
              wanted === ''
                ? '这条待办还没有绑定会话；先用「新会话」派发一次，或改用 auto 模式'
                : `绑定的会话已不在（${wanted}）；改用 auto 模式会自动开一个新会话`,
            )
          }
        } else {
          sendTo(target, prompt, todo.title)
          await service.recordDispatch(id, { mode: 'bound', ok: true, sessionId: wanted, dir })
          notify(onDispatched, wanted, log)
          return { todo: await service.get(id), mode: 'bound', sessionId: wanted, reused: true }
        }
      }

      const spawned = await spawnSession(todo, { dir, sourceSessionId: todo.sessionId })
      if (spawned?.agent === undefined) {
        throw new TodoError('dispatch-failed', '新会话已创建但拿不到 agent 句柄，无法投递内容')
      }
      sendTo(spawned.agent, prompt, todo.title)
      await service.recordDispatch(id, { mode: 'new', ok: true, sessionId: spawned.sessionId, dir })
      notify(onDispatched, spawned.sessionId, log)
      return { todo: await service.get(id), mode: 'new', sessionId: spawned.sessionId, reused: false, dir }
    } catch (error) {
      if (error instanceof TodoError) return fail(error)
      return fail(new TodoError('dispatch-failed', asTodoError(error).message))
    }
  }

  /**
   * Is the session bound to this todo still alive?
   *
   * The panel uses it to say 「会话在跑」 instead of 「已绑定会话」, which is the
   * difference between "hand it over again" and "that conversation is gone".
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  function sessionAlive(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const store = agents()
    if (store === undefined) return false
    try {
      return store.get(sessionId) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Working directory of a live session, or '' when unknown.
   *
   * The panel uses it to warn about a conversation that cannot do the work —
   * a session without a directory is the failure this plugin created once, and
   * the warning is how a person notices before handing work over again.
   *
   * @param {string} sessionId
   * @returns {string}
   */
  function sessionDir(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    const store = agents()
    if (store === undefined) return ''
    try {
      const cwd = store.get(sessionId)?.session?.header?.cwd
      return typeof cwd === 'string' ? cwd : ''
    } catch {
      return ''
    }
  }

  /**
   * Ask the conversation in front of the user to collect todos from itself.
   *
   * This is a hand-off of *work*, not of a todo: nothing is recorded against a
   * record and no completion is expected, because the outcome is new todos rather
   * than a finished one.
   *
   * @param {{ sessionId?: string }} [request]
   * @returns {Promise<{ sessionId: string, requested: true }>}
   */
  async function requestCapture(request = {}) {
    const store = agents()
    if (store === undefined) {
      throw new TodoError('agents-unavailable', '这个宿主没有 agents 服务，无法把抓取请求交给会话')
    }
    const wanted = resolveCurrentSession({
      store,
      requested: typeof request.sessionId === 'string' ? request.sessionId : '',
      recent: getRecentSession?.(),
    })
    if (wanted === '') {
      throw new TodoError(
        'dispatch-failed',
        '找不到「当前对话」：先在任意对话里说一句话，让我知道你在哪里，再点抓取。',
      )
    }
    const target = store.get(wanted)
    sendTo(target, service.capturePrompt(), '全局待办 · 抓取')
    log('info', `asked ${wanted} to capture todos`)
    return { sessionId: wanted, requested: true }
  }

  return {
    dispatch,
    requestCapture,
    capabilities,
    sessionAlive,
    sessionDir,
    resolveDir,
    resolveCurrentSession,
    modes: DISPATCH_MODES,
  }
}
