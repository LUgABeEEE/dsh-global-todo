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

import { createCompletionWatcher } from './completion.js'
import { createDispatcher } from './dispatch.js'
import { LIMITS } from './model.js'
import { ROUTE_BASE, createRoutes } from './routes.js'
import { createService } from './service.js'
import { createStore, resolveStorePath } from './store.js'
import { createTools } from './tools.js'

/** Must equal `package.json`'s version; `npm run check` enforces that. */
export const VERSION = '0.1.0'

/** Plugin id. Also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-global-todo'

/** Applied when the profile's patch row gives no `config`. */
export const DEFAULTS = Object.freeze({
  storePath: '',
  dispatchDir: '',
  activityLimit: LIMITS.activity,
  requireExistingFiles: true,
  guidance: true,
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
  '【全局待办】有一份跨会话、跨工作区、人和你共用的清单（`global_todo_*` 工具）。它和内置 `todo_write` 不是一回事：那个是你这个会话的计划，这份属于用户。',
  '',
  '该**主动**记（不必等用户开口）：用户提到需要跨会话跟进的事——等对方回复、下周要交、待确认的决定、答应别人的事；一轮收尾时发现「还有一步没做」且不该在这个会话里继续；用户说「记一下 / 别忘了 / 回头办」。',
  '**不要**记：你自己这一步就能做完的、会话内的执行计划、纯闲聊。宁可少记。',
  '主动记完，用一句话说明记了什么（别把整条描述复述一遍）。挂上相关文档路径与网址（`links`），接手时会作为上下文一起交给对方。',
  '',
  '用户说「抓一下待办 / 整理一下要跟进的」时：扫最近对话，用 `global_todo_capture` 一次登记多条，再回一句汇总。',
  '做完一件事用 `global_todo_done` 标记（留痕），不要删。',
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
  const service = createService({ store, config: resolved, logger })
  // Auto-completion: when a handed-off session finishes a turn cleanly, the
  // record says so by itself. Wired before the dispatcher so a hand-off can
  // announce itself; guarded, because a Host without the event just keeps the
  // manual path.
  // Which conversation did the user last write in? The panel is the main view
  // while it is open, so it cannot always see that; the Host can, from the
  // session-activity feed. This is what makes 「交给 Agent」 mean "hand it to the
  // chat I am talking in" instead of "open yet another session".
  const recentSession = { id: '', watching: typeof ctx?.on === 'function' }
  ctx.effect(() => {
    if (typeof ctx?.on !== 'function') return () => {}
    try {
      const dispose = ctx.on('api-session/activity', (sessionId) => {
        if (typeof sessionId === 'string' && sessionId !== '') recentSession.id = sessionId
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
  const dispatcher = createDispatcher({
    ctx,
    service,
    config: resolved,
    logger,
    onDispatched: (sessionId) => watcher.expect(sessionId),
    getRecentSession: () => recentSession.id,
  })

  /** Surfaced by `/health`, so a silently missing surface is visible. */
  const toolState = { registered: [], error: null }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      try {
        const definitions = createTools(service)
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
      const routes = createRoutes({
        service,
        dispatcher,
        logger,
        connection: ctx.get?.('connection'),
        tools: toolState,
        completion: watcherState,
        target: recentSession,
        version: VERSION,
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
