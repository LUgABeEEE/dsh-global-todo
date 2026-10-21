/**
 * dsh-global-todo — host half.
 *
 * A global todo list: one file, owned by the human and the agent together.
 * Every entry records when it was added, may carry a description plus any
 * number of attached documents and addresses, and can be handed to an agent
 * session with one click.
 *
 * This entry wires four things and nothing else:
 *
 *  - `store`      — where the list lives (one JSON file, atomic writes)
 *  - `service`    — the single write path both writers use
 *  - `dispatcher` — handing a todo to an agent session
 *  - `tools` / `webServer` / `systemPrompt` — the three optional surfaces
 *
 * No `@deepseek-ai/*` import: the tools use raw JSON Schema and the routes use
 * the plain `webServer.register` contract, so the plugin keeps working across
 * 0.2.x releases and in lean compositions that lack a service.
 *
 * @module dsh-global-todo
 */

import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createCompletionWatcher, messageText } from './completion.js'
import { createDispatcher } from './dispatch.js'
import { createSettings, explainAutoCollect, idleSessions, retryDelayMs } from './settings.js'
import { createDiagnostics } from './diagnostics.js'
import { createMetrics } from './metrics.js'
import { dueReminders } from './reminders.js'
import { LIMITS } from './model.js'
import { ROUTE_BASE, createRoutes } from './routes.js'
import { createService } from './service.js'
import { createStore, resolveStorePath } from './store.js'
import { createTools } from './tools.js'

/** Must equal `package.json`'s version; `npm run check` enforces that. */
export const VERSION = '0.12.11'

/** Plugin id. Also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-global-todo'

/** Applied when the profile's patch row gives no `config`. */
export const DEFAULTS = Object.freeze({
  storePath: '',
  dispatchDir: '',
  activityLimit: LIMITS.activity,
  requireExistingFiles: true,
  guidance: true,
  // Starting point for the built-in folder browser when the shell has no picker.
  // Documented here because a patch override replaces `config` wholesale and has
  // to restate every key it wants to keep.
  browseRoot: '',
})

/**
 * Guidance for the model.
 *
 * This is the one place where the plugin asks the agent to do something on its
 * own initiative, so it states both sides: the situations that should produce a
 * todo, and the ones that must not. A prompt that only says "remember things"
 * produces noise, and a noisy list is worse than an empty one.
 *
 * Kept short on purpose: it is injected on every turn.
 */
const GUIDANCE = [
  '【全局待办】一份跨会话、跨工作区、人和你共用的待办清单（`global_todo_*` 工具）。它和内置 `todo_write` 不是一回事：那个是你这个会话的计划，这份属于用户、跨会话保留。',
  '',
  '**主动记**——不必等用户开口；问「要不要记一下」是错的，直接记：',
  '- 用户提到需要**跨会话**跟进的事：等对方回复、下周要交、待确认的决定、答应别人的事；',
  '- 你说过「我先做完 X，回头再 Y」，而 Y 不该在本会话继续；',
  '- 一轮收尾时发现**还有一步没做**，且它需要别的会话、别的设备或用户本人；',
  '- 用户说「记一下 / 别忘了 / 回头办」。',
  '**不要记**：你这一步就能做完的、本会话内的执行计划、纯闲聊。宁可少记。',
  '记的时候：标题一句话说清要做什么；把相关文档**绝对路径**或网址挂进 `links`（接手时会作为上下文一起交出去）；需要精确时间的写 `dueAt`。',
  '**大活拆步骤**：一件需要多轮才能做完的事，用 `steps` 记下 3–6 步（`global_todo_add` 的 `steps` 参数）——派发时这些步骤会作为编号计划原样交给接手的 Agent，比一段散文有用得多；做完一步就用 `global_todo_update` 把该步的 `done` 置为 true。',
  '记完用一句话说明记了什么（别复述整条描述）。做完用 `global_todo_done` 留痕，**不要删**。',
  '**一轮收尾时顺手划掉**：如果清单里某条就是你刚做完的事，直接 `global_todo_done` 结束它，别留着占地方（插件也会在你安静下来后自动划掉，但你先划更准）。',
  '做不到 / 卡住了：用 `global_todo_note` 追加一条进展，说明卡在哪、需要用户做什么——**不要**改写待办的 description（那是用户自己的文字）。',
  '用户说「抓一下待办 / 整理一下要跟进的」时：扫最近对话，用 `global_todo_capture` 一次登记多条，再回一句汇总。',
].join('\n')

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis context
 * @param {object} [config] - the patch row's `config`
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  const logger = ctx?.logger

  const file = resolveStorePath(resolved)
  const store = createStore({
    file,
    logger,
    activityLimit: resolved.activityLimit,
  })
  // Runtime counters for /health: in memory, optional everywhere, and never read
  // back by the plugin itself.
  const metrics = createMetrics()
  const service = createService({ store, config: resolved, logger, metrics })
  // The inbox must not become a second list. A weekly sweep archives what nobody
  // confirmed; the record keeps its history, it just leaves the active view.
  ctx.effect(() => {
    const sweep = () => {
      void service
        .expireInbox({ days: 7 })
        .then((result) => {
          if (result?.expired > 0) logger?.info?.(`dsh-global-todo: archived ${result.expired} unconfirmed inbox item(s)`)
        })
        .catch((error) => logger?.warn?.(`dsh-global-todo: inbox expiry failed: ${error?.message ?? error}`))
    }
    sweep()
    if (typeof setInterval !== 'function') return () => {}
    const timer = setInterval(sweep, 6 * 60 * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-global-todo: inbox expiry')
  // Which conversation did the user last write in?
  //
  // The panel is the main view while it is open, so it cannot always see that.
  // The obvious feed — `api-session/activity` — is not usable as-is: it reports
  // any user-authored durable message, and a hand-off *is* one (the plugin
  // injects a user-role message into the target). Tracking that made every
  // dispatch pull "the current conversation" towards the conversation it had
  // just dispatched to, so the next click followed the last one instead of the
  // person. Reading the session log lets us keep only messages a person wrote.
  // Kept on disk as well as in memory: this plugin restarts with the Host, and an
  // empty tracker falls back to the panel's stale guess — which is how a hand-off
  // reached the wrong conversation once already.
  const recentFile = path.join(path.dirname(file), 'recent-session.json')
  const recentSession = { id: '', watching: typeof ctx?.on === 'function', file: recentFile }
  // What a bound conversation last said, remembered while its events stream by.
  // Read-back has to be cheap: the panel asks on every opened row, and going to the
  // session log per row would make opening a todo wait on disk. Bounded, text-only,
  // never persisted — a stale tail is better than no answer, and it costs no write.
  const SESSION_TAIL_LIMIT = 200
  const sessionTails = new Map()
  const rememberTail = (sessionId, text, at) => {
    if (sessionId === '' || text === '') return
    if (sessionTails.size >= SESSION_TAIL_LIMIT && !sessionTails.has(sessionId)) {
      // Oldest insertion first: a Map keeps insertion order, so one delete is enough.
      const oldest = sessionTails.keys().next()
      if (oldest.done !== true) sessionTails.delete(oldest.value)
    }
    sessionTails.set(sessionId, { text: text.slice(0, 400), at, length: text.length })
  }

  /** Best-effort: losing this file costs a guess, never a write. */
  const rememberSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '' || recentSession.id === sessionId) return
    recentSession.id = sessionId
    void writeFile(recentFile, `${JSON.stringify({ id: sessionId, at: Date.now() })}\n`, 'utf8').catch(() => {})
  }

  ctx.effect(() => {
    void readFile(recentFile, 'utf8')
      .then((text) => {
        const parsed = JSON.parse(text)
        if (typeof parsed?.id === 'string' && parsed.id !== '' && recentSession.id === '') recentSession.id = parsed.id
      })
      .catch(() => {
        /* absent or unreadable: the tracker simply starts empty */
      })
    return () => {}
  }, 'dsh-global-todo: recent session file')
  ctx.effect(() => {
    if (typeof ctx?.on !== 'function') return () => {}
    try {
      const dispose = ctx.on('session/event', (first, second) => {
        try {
          const session = first?.id !== undefined && first?.header !== undefined ? first : second
          const event = typeof first?.type === 'string' ? first : typeof second?.type === 'string' ? second : undefined
          // Every assistant message updates the read-back cache; only a person typing
          // moves the recent-session pointer.
          if (event !== undefined && event.type === 'assistant/message' && typeof session?.id === 'string') {
            rememberTail(session.id, messageText(event.data?.message), Date.now())
          }
          if (event === undefined || event.type !== 'user/message') return
          // `source.kind === 'user'` means a person typed it: model turns, tool
          // results and plugin injections all carry a different kind.
          if (event.data?.source?.kind !== 'user') return
          if (typeof session?.id === 'string' && session.id !== '') rememberSession(session.id)
        } catch {
          /* a malformed event must not break the feed */
        }
      })
      recentSession.watching = true
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    } catch (error) {
      recentSession.watching = false
      logger?.warn?.(`dsh-global-todo: 无法跟踪会话活动：${String(error?.message ?? error)}`)
      return () => {}
    }
  }, 'dsh-global-todo: recent session')

  // Auto-completion: when a handed-off session finishes a turn cleanly, the
  // record says so by itself. Wired before the dispatcher so a hand-off can
  // announce itself; guarded, because a Host without the event just keeps the
  // manual path.
  // Automatic collect: ask a conversation what needs following up — but only once it has
  // gone **quiet**.
  //
  // Asking at `turn/end` was wrong on its face: a working session ends turns every few
  // minutes, so the question arrived mid-work and arrived often. Now a clean turn only
  // *marks* the conversation as a candidate, the moment is recorded, and a timer asks when
  // nothing has been said for `idleMinutes` (default 30). Any new message restarts that
  // clock, so a session in use is never asked.
  const collectPending = {}
  const collectActivity = {}
  // Sessions whose question failed: when the next attempt is allowed, and how many
  // attempts have failed. Two maps because the decision layer takes timestamps only.
  const collectRetry = {}
  const collectAttempts = {}
  const ASK_TIMEOUT_MS = 10_000
  const ASK_MAX_ATTEMPTS = 3

  /**
   * Bound a promise the plugin does not control.
   *
   * `requestCapture` may wait on `agents.resume`, and a resume that never settles left
   * `asking` true forever — which silences the feature for every conversation, not just
   * the broken one.
   */
  const withinMs = (promise, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${Math.round(ms / 1000)} 秒没有结果`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  // When a *person* last wrote in each conversation. The question we send is a message in
  // the conversation too, and re-arming on it is exactly the loop this exists to break — so
  // only `source.kind === 'user'` counts as somebody having answered.
  const collectHuman = {}
  // The last working directory each conversation was seen in, learned from its own events.
  // The live lookup below is only a fallback for a conversation that has not been seen yet.
  const collectDir = {}

  const askSession = async (sessionId) => {
    if (autoCollectState.asking === true) return
    autoCollectState.asking = true
    autoCollectState.stats.asked += 1
    try {
      // Book first: a question that fails must not be repeated in a burst. The booking is
      // released below when the question did not arrive, because a failure is not an answer.
      await settings.rememberAsked(sessionId, Date.now())
      const result = await withinMs(dispatcher.requestCapture({ sessionId, authoritative: true }), ASK_TIMEOUT_MS)
      autoCollectState.lastAsk = { at: Date.now(), sessionId: result?.sessionId ?? sessionId }
      autoCollectState.error = null
      autoCollectState.stats.succeeded += 1
      autoCollectState.lastRetry = null
      delete collectRetry[sessionId]
      delete collectAttempts[sessionId]
      delete collectPending[sessionId]
    } catch (error) {
      const message = String(error?.message ?? error)
      const attempts = (collectAttempts[sessionId] ?? 0) + 1
      autoCollectState.error = message
      autoCollectState.stats.failed += 1
      // A failure is not an answer: leaving the booking behind made `awaiting-human` keep
      // the conversation quiet until a person happened to speak again.
      await settings.forgetAsked(sessionId).catch(() => {})
      if (attempts >= ASK_MAX_ATTEMPTS) {
        delete collectRetry[sessionId]
        delete collectAttempts[sessionId]
        delete collectPending[sessionId]
        autoCollectState.stats.dropped += 1
        autoCollectState.lastDrop = { at: Date.now(), sessionId, attempts, error: message }
      } else {
        const at = Date.now()
        collectAttempts[sessionId] = attempts
        collectRetry[sessionId] = at + retryDelayMs(attempts)
        autoCollectState.lastRetry = { at, sessionId, attempts, nextAt: collectRetry[sessionId] }
      }
      logger?.warn?.(`dsh-global-todo: 自动抓取失败（${message}），第 ${attempts} 次`)
    } finally {
      autoCollectState.asking = false
    }
  }

  ctx.effect(() => {
    if (typeof ctx?.on !== 'function') return () => {}
    try {
      const dispose = ctx.on('session/event', (first, second) => {
        try {
          const session = first?.id !== undefined && first?.header !== undefined ? first : second
          const event = typeof first?.type === 'string' ? first : typeof second?.type === 'string' ? second : undefined
          if (event === undefined) return
          const sessionId = typeof session?.id === 'string' ? session.id : ''
          if (sessionId === '') return
          // The conversation's working directory, remembered from the event rather than looked
          // up when the timer runs. A conversation that has gone quiet is exactly the one the
          // Host may have unloaded since, and the agents service answers '' for a session it no
          // longer holds — which would make a directory-keyed exemption stop applying to the
          // very conversations that need it. The header is frozen at creation, so once seen it
          // cannot go stale. An exemption decided on a directory that reads as '' is not a
          // decision at all.
          if (typeof session?.header?.cwd === 'string' && session.header.cwd !== '') {
            collectDir[sessionId] = session.header.cwd
          }
          autoCollectState.enabled = settings.get().autoCollect === true

          // Anything said, and any turn starting, restarts the quiet clock.
          if (event.type === 'user/message' || event.type === 'turn/start') {
            collectActivity[sessionId] = Date.now()
            // A person typing is the only thing that re-arms a conversation that has already
            // been asked; model turns, tool results and our own notice do not.
            if (event.data?.source?.kind === 'user') collectHuman[sessionId] = Date.now()
            return
          }
          if (event.type !== 'turn/end') return
          if (event.data?.reason?.kind !== 'completed') return
          // A clean turn makes it a candidate, and *this* is when it went quiet.
          collectPending[sessionId] = Date.now()
          collectActivity[sessionId] = Date.now()
        } catch (error) {
          autoCollectState.error = String(error?.message ?? error)
        }
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    } catch (error) {
      autoCollectState.error = String(error?.message ?? error)
      logger?.warn?.(`dsh-global-todo: 自动抓取无法挂载：${autoCollectState.error}`)
      return () => {}
    }
  }, 'dsh-global-todo: auto collect watch')

  ctx.effect(() => {
    if (typeof setInterval !== 'function') return () => {}
    // One minute is plenty for a half-hour rule and costs nothing.
    const timer = setInterval(() => {
      try {
        const current = settings.get()
        autoCollectState.enabled = current.autoCollect === true
        const now = Date.now()
        const idle = idleSessions({
          pending: collectPending,
          activityAt: collectActivity,
          idleMinutes: current.idleMinutes ?? 30,
          now,
        })
        // Going quiet is not a verdict on the work — a conversation waiting on a person or on
        // an event goes quiet *because* it is unfinished, which makes quiet the wrong signal
        // to close a todo on. Nothing is closed here; see DESIGN.md, "Quiet is not a verdict".
        // With the switch off there is nothing to ask for either, so the candidates are
        // dropped rather than left to fire in a burst the moment it is switched on.
        if (current.autoCollect !== true) {
          for (const sessionId of idle) {
            delete collectPending[sessionId]
            // A retry belongs to a candidate; with the switch off there is nothing to retry.
            delete collectRetry[sessionId]
            delete collectAttempts[sessionId]
          }
        }
        autoCollectState.waiting = Object.keys(collectPending).length
        // An exemption is keyed on the working directory. What the conversation's own events
        // reported wins, because an unloaded conversation is the normal state of one that has
        // gone quiet; the agents service is only the fallback, and it answers '' for a session
        // it no longer holds — which is not an exemption.
        const dirAt = {}
        for (const sessionId of Object.keys(collectPending)) {
          dirAt[sessionId] = collectDir[sessionId] ?? dispatcher.sessionDir(sessionId)
        }
        const decisions = explainAutoCollect({
          pending: collectPending,
          activityAt: collectActivity,
          humanAt: collectHuman,
          dirAt,
          retryAt: collectRetry,
          settings: current,
          recentSessionId: recentSession.id,
          now,
        })
        const due = decisions.filter((decision) => decision.ask)
        autoCollectState.waiting = Object.keys(collectPending).length
        autoCollectState.due = due.length
        // The reason used to be computed and dropped on the floor; keep the list so /health
        // can answer "why was this conversation not asked?".
        autoCollectState.decisions = decisions.slice(0, 20)
        const shown = due[0] ?? decisions[0]
        autoCollectState.lastDecision =
          shown === undefined
            ? null
            : { at: now, sessionId: shown.sessionId, ask: shown.ask === true, reason: shown.reason, idleMs: shown.idleMs }
        if (current.autoCollect !== true || autoCollectState.asking === true) return
        if (due.length === 0) return
        void askSession(due[0].sessionId)
      } catch (error) {
        autoCollectState.error = String(error?.message ?? error)
      }
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-global-todo: auto collect timer')

  const watcher = createCompletionWatcher({ ctx, service, logger })
  // Surfaced by `/health` too: a capability that silently failed to attach is
  // indistinguishable from one that was never built.
  const watcherState = { watching: typeof ctx?.on === 'function', error: null }
  ctx.effect(() => {
    try {
      const dispose = watcher.start()
      watcherState.watching = typeof ctx?.on === 'function'
      return () => {
        watcherState.watching = false
        dispose()
      }
    } catch (error) {
      watcherState.error = String(error?.message ?? error)
      return () => {}
    }
  }, 'dsh-global-todo: completion watcher')
  // Settings live beside the todo file: the automatic switch has to survive the
  // panel being closed, because the Host is what acts on it.
  // Panel error reporting. Bounded on purpose: a failing panel retries every poll, and
  // an unbounded log is worse than no log.
  const diagnostics = createDiagnostics({ file: path.join(path.dirname(file), 'client-errors.log'), logger })
  const settingsFile = path.join(path.dirname(file), 'settings.json')
  const settings = createSettings({ file: settingsFile, logger })
  // Deadlines that have passed and were not announced yet. In memory on purpose: a restart
  // re-announces an unacknowledged deadline once, which is the offline catch-up a reminder
  // is supposed to have.
  const reminderState = { due: [], reminded: {} }
  ctx.effect(() => {
    const tick = async () => {
      try {
        const current = settings.get()
        if (current.remindersEnabled === false) {
          reminderState.due = []
          return
        }
        const { todos } = await service.list({ status: 'active' })
        const due = dueReminders(todos, {
          now: Date.now(),
          reminded: reminderState.reminded,
          leadMs: (current.reminderLeadMinutes ?? 0) * 60_000,
        })
        if (due.length === 0) return
        for (const item of due) reminderState.reminded[item.id] = item.dueAt
        const known = new Set(reminderState.due.map((item) => item.id))
        reminderState.due = [...reminderState.due, ...due.filter((item) => !known.has(item.id))]
      } catch (error) {
        logger?.warn?.(`dsh-global-todo: reminder sweep failed: ${error?.message ?? error}`)
      }
    }
    void tick()
    if (typeof setInterval !== 'function') return () => {}
    const timer = setInterval(() => void tick(), 30_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-global-todo: due reminders')
  const autoCollectState = {
    enabled: false,
    asking: false,
    lastAsk: null,
    error: null,
    waiting: 0,
    due: 0,
    decisions: [],
    lastDecision: null,
    lastRetry: null,
    lastDrop: null,
    // In-memory on purpose: it describes this process, not the list. Restarting resets it.
    stats: { asked: 0, succeeded: 0, failed: 0, dropped: 0 },
  }
  ctx.effect(() => {
    void settings.load().then((loaded) => {
      autoCollectState.enabled = loaded.autoCollect === true
    })
    return () => {}
  }, 'dsh-global-todo: settings file')

  const dispatcher = createDispatcher({
    ctx,
    service,
    config: resolved,
    logger,
    metrics,
    onDispatched: (sessionId) => watcher.expect(sessionId),
    getRecentSession: () => recentSession.id,
  })

  /** Surfaced by `/health`, so a silently missing surface is visible. */
  const toolState = { registered: [], error: null }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      try {
        const definitions = createTools(service, { metrics })
        const disposers = definitions.map((definition) => toolCtx.tools.register(definition))
        toolState.registered = definitions.map((definition) => definition.name)
        toolState.error = null
        toolCtx.logger?.info?.(`dsh-global-todo: 注册了 ${definitions.length} 个 Agent 工具`)
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* unloading must not throw */
            }
          }
        }
      } catch (error) {
        toolState.error = String(error?.message ?? error)
        toolCtx.logger?.warn?.(`dsh-global-todo: 工具注册失败：${toolState.error}`)
        return () => {}
      }
    }, 'dsh-global-todo: agent tools')
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      // The running module is the truth for behaviour; package.json is the truth for what
      // was installed. When they differ the host is still executing the old graph, and
      // nothing else in the system says so.
      let diskVersion
      try {
        diskVersion = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
      } catch {
        diskVersion = undefined
      }
      const routes = createRoutes({
        service,
        dispatcher,
        logger,
        // Handed over as a context, not as a value: the connection fence can register
        // after this plugin, and reading it once at mount time captured `undefined`
        // (which silently downgraded every LAN/tunnel request to 403).
        diagnostics,
        metrics,
        config: resolved,
        rootCtx: ctx,
        connection: ctx.get?.('connection'),
        tools: toolState,
        completion: watcherState,
        target: recentSession,
        sessionTail: (sessionId) => sessionTails.get(sessionId) ?? null,
        settings,
        autoCollect: autoCollectState,
        reminders: reminderState,
        version: VERSION,
        // What is on disk, which after an upgrade is not what this process is running.
        // The panel talks to a tree that changed under it; /health is where that is visible.
        diskVersion,
      })
      const disposers = routes.map((definition) => webCtx.webServer.register(definition))
      webCtx.logger?.info?.(`dsh-global-todo: 注册了 ${disposers.length} 条路由（${ROUTE_BASE}）`)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* unloading must not throw */
          }
        }
      }
    }, 'dsh-global-todo: web routes')
  })

  if (resolved.guidance !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        const dispose = promptCtx.systemPrompt.section({
          name: 'dsh-global-todo:guidance',
          order: 3040,
          text: GUIDANCE,
        })
        return () => {
          try {
            dispose?.()
          } catch {
            /* unloading must not throw */
          }
        }
      } catch (error) {
        logger?.warn?.(`dsh-global-todo: 用法指引注册失败：${error?.message ?? error}`)
        return () => {}
      }
    })
  }

  logger?.info?.(`dsh-global-todo v${VERSION} 已挂载（store=${file}）`)
}

export default { name, apply }
