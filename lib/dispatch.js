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
  /**
   * The workspace a brand-new session belongs to.
   *
   * A hand-off continues work that already has a home: the workspace owning the
   * conversation that wrote the todo (or the one it was handed from), or a
   * workspace the user named. Only when none of those is known does the working
   * directory decide — that fallback used to be the only rule, which is how new
   * conversations ended up beside unrelated ones.
   *
   * @param {{ workspaceId?: string, originSessionId?: string, sourceSessionId?: string, dir?: string }} context
   * @returns {Promise<{ workspace: object | undefined, via: string }>}
   */
  async function resolvePlacement(context = {}) {
    const registry = rootCtx()?.get?.('workspaceRegistry')
    if (registry === undefined || registry === null) return { workspace: undefined, via: 'no-service' }
    const ownerOf = (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        return registry.list().find((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
      } catch {
        return undefined
      }
    }
    try {
      if (typeof context.workspaceId === 'string' && context.workspaceId !== '' && typeof registry.get === 'function') {
        const chosen = registry.get(context.workspaceId)
        if (chosen !== undefined) return { workspace: chosen, via: 'chosen' }
      }
      for (const [candidate, via] of [
        [context.originSessionId, 'origin'],
        [context.sourceSessionId, 'source'],
      ]) {
        const owner = ownerOf(candidate)
        if (owner !== undefined) return { workspace: owner, via }
      }
      if (typeof context.dir === 'string' && context.dir !== '') {
        let workspace = await registry.resolveByPath(context.dir)
        if (workspace === undefined) workspace = await registry.create(context.dir)
        return { workspace, via: 'dir' }
      }
      return { workspace: undefined, via: 'none' }
    } catch (error) {
      log('warn', '解析新会话应归属的工作区失败', error)
      return { workspace: undefined, via: 'failed' }
    }
  }

  /**
   * @param {string} sessionId
   * @param {object | undefined} workspace
   * @returns {Promise<string>} what happened, for the log
   */
  async function attachToWorkspace(sessionId, workspace) {
    if (workspace === undefined || typeof workspace.attachSession !== 'function') return 'no-workspace'
    try {
      await workspace.attachSession(sessionId)
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
    // Resolve where it belongs *before* creating it: the owning workspace's path
    // is also the sensible working directory, so the agent and the sidebar agree.
    const placement = await resolvePlacement({
      workspaceId: context.workspaceId,
      originSessionId: context.originSessionId,
      sourceSessionId: context.sourceSessionId,
      dir: typeof context.dir === 'string' ? context.dir.trim() : '',
    })
    const inherited = typeof placement.workspace?.path === 'string' ? placement.workspace.path : ''
    const dir = inherited !== '' ? inherited : typeof context.dir === 'string' ? context.dir.trim() : ''
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
    const attached = await attachToWorkspace(sessionId, placement.workspace)
    // The Host's Workspace entity exposes `id`; the Client's WorkspaceView calls the
    // same value `workspaceId`. Read both so the reply names the workspace instead
    // of an empty string.
    const workspaceId = placement.workspace?.id ?? placement.workspace?.workspaceId ?? ''
    return { sessionId, agent: handle?.agent, workspace: workspaceId, placed: placement.via, attached }
  }

  /**
   * A live agent for `sessionId`, resuming a persisted session when it is not
   * currently loaded.
   *
   * Without this, picking a conversation that is not running fell through to a
   * different one — the work went somewhere the person did not choose, twice.
   *
   * @param {string} sessionId
   * @returns {Promise<{ agent: object | undefined, resumed: boolean }>}
   */
  async function ensureAgent(sessionId) {
    const store = agents()
    if (store === undefined) return { agent: undefined, resumed: false }
    const existing = store.get(sessionId)
    if (existing !== undefined) return { agent: existing, resumed: false }
    if (typeof store.resume !== 'function') return { agent: undefined, resumed: false }
    const handle = await store.resume({ resumeSessionId: sessionId, agentOptions: modelSelection(undefined) })
    return { agent: handle?.agent, resumed: true }
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
    // An explicit pick is not a guess and must never be substituted — that is
    // what made 「选了之后还是交给你」 possible. It is returned as-is; whether it
    // can be woken up is decided where the message is sent.
    if (input.authoritative === true && typeof input.requested === 'string' && input.requested !== '') {
      return input.requested
    }
    // Otherwise: a caller that knows (a button inside a conversation) first, then
    // the activity feed. While the panel is the main view its own idea of "the
    // session on screen" is whatever the view retained earlier, so the feed — a
    // real user message — outranks it.
    const candidates =
      input.authoritative === true
        ? [input.requested, input.recent, input.todo?.originSessionId]
        : [input.recent, input.requested, input.todo?.originSessionId]
    let fallback = ''
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate === '') continue
      if (fallback === '') fallback = candidate
      try {
        if (store.get(candidate) !== undefined) return candidate
      } catch {
        /* a candidate the registry refuses is simply skipped */
      }
    }
    // Nothing is live: still name the best candidate, so it can be resumed
    // instead of quietly handing the work to a different conversation.
    return fallback
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
          authoritative: request.authoritative === true,
        })
        if (wanted === '') {
          throw new TodoError(
            'dispatch-failed',
            '找不到「当前对话」：面板不知道你在哪个对话里，Host 也没看到你最近说过话。'
              + '先在任意对话里说一句，或改用「开新对话」。',
          )
        }
        let live
        try {
          live = await ensureAgent(wanted)
        } catch (error) {
          throw new TodoError(
            'dispatch-failed',
            `那个对话（…${wanted.slice(-8)}）现在没在运行，而且加载它失败了：${asTodoError(error).message}`,
          )
        }
        if (live.agent === undefined) {
          throw new TodoError(
            'dispatch-failed',
            `那个对话（…${wanted.slice(-8)}）现在没在运行，宿主也无法把它加载起来。`
              + '先在侧栏打开它、或给它发一句话让它加载，再重派；或改用「开新对话」。',
          )
        }
        const target = live.agent
        sendTo(target, prompt, todo.title)
        await service.recordDispatch(id, { mode, ok: true, sessionId: wanted, dir: currentDirOf(target) })
        notify(onDispatched, wanted, log)
        if (live.resumed) log('info', `resumed ${wanted} to deliver a hand-off`)
        return {
          todo: await service.get(id),
          mode,
          sessionId: wanted,
          reused: true,
          resumed: live.resumed,
          dir: currentDirOf(target),
          target: wanted,
        }
      }

      // `auto` with nothing usable to fall back on hands the work to the
      // conversation the user is in, rather than opening a session they did not
      // ask for.
      const boundUsable = todo.sessionId !== '' && bound !== undefined && sessionDir(todo.sessionId) !== ''
      const currentId =
        mode === 'auto'
          ? resolveCurrentSession({
              store,
              requested: typeof request.sessionId === 'string' ? request.sessionId : '',
              recent: getRecentSession?.(),
              todo,
              authoritative: request.authoritative === true,
            })
          : ''
      if (mode === 'auto' && boundUsable !== true && currentId !== '') {
        let live
        try {
          live = await ensureAgent(currentId)
        } catch {
          live = { agent: undefined, resumed: false }
        }
        if (live.agent !== undefined) {
          sendTo(live.agent, prompt, todo.title)
          await service.recordDispatch(id, {
            mode: 'current',
            ok: true,
            sessionId: currentId,
            dir: currentDirOf(live.agent),
          })
          notify(onDispatched, currentId, log)
          if (live.resumed) log('info', `resumed ${currentId} to deliver a hand-off`)
          return {
            todo: await service.get(id),
            mode: 'current',
            sessionId: currentId,
            reused: true,
            resumed: live.resumed,
            dir: currentDirOf(live.agent),
            target: currentId,
          }
        }
        // It cannot be woken up: `auto` is allowed to look elsewhere, so the
        // bound/new paths below decide.
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
          return { todo: await service.get(id), mode: 'bound', sessionId: wanted, reused: true, target: wanted }
        }
      }

      const spawned = await spawnSession(todo, {
        dir,
        workspaceId: typeof request.workspaceId === 'string' ? request.workspaceId : '',
        originSessionId: todo.originSessionId,
        sourceSessionId: todo.sessionId,
      })
      if (spawned?.agent === undefined) {
        throw new TodoError('dispatch-failed', '新会话已创建但拿不到 agent 句柄，无法投递内容')
      }
      sendTo(spawned.agent, prompt, todo.title)
      await service.recordDispatch(id, { mode: 'new', ok: true, sessionId: spawned.sessionId, dir })
      notify(onDispatched, spawned.sessionId, log)
      return {
        todo: await service.get(id),
        mode: 'new',
        sessionId: spawned.sessionId,
        reused: false,
        dir,
        target: spawned.sessionId,
        workspace: spawned.workspace,
        placed: spawned.placed,
      }
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
      authoritative: request.authoritative === true,
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
