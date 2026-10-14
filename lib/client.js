/**
 * dsh-global-todo — client half (browser bundle).
 *
 * This file is what `exports["./client"]` points at: a self-registering lazy
 * factory picked up by `window.__ModuleLoader__` in the browser. Constraints
 * this file obeys on purpose:
 *
 *  - only platform modules are required (`react`); nothing is imported from
 *    another Harness client package, so no external wiring is needed;
 *  - colors come from `--dsw-alias-*` theme tokens only, so light and dark
 *    themes both work;
 *  - UI is contributed through slots, never by writing outside its own tree;
 *  - the factory body has no side effects — everything is registered in `apply`
 *    through `ctx.effect` with a disposer.
 *
 * Data channel: the host half's HTTP routes, called with a **document-relative**
 * path (`api/global-todo/...`). The GUI serves the app under `<base href="./">`,
 * so a root-absolute fetch would escape the prefix in a sub-path deployment.
 *
 * Service methods are always invoked **on** their service: the host's services
 * are class instances whose methods touch `this`, and a detached call throws.
 * A throw inside an effect is not a cosmetic problem — the shell retires a
 * crashing slot entry from its cell, which the user sees as a blank panel — so
 * the locale subscription is additionally wrapped, and the panel runs inside
 * its own error boundary.
 *
 * @module dsh-global-todo/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-global-todo',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    /** Slot ids. The sidebar entry id and the main panel key must match. */
    const SLOT_ID = 'global-todo'
    const LOCALE_NS = 'global-todo'
    /** Route prefix, relative to the document base. */
    const API = 'api/global-todo'
    const POLL_MS = 20000
    /** How long a deleted todo can be brought back. */
    const UNDO_MS = 8000
    /** How many attachment chips a row shows before collapsing into `+N`. */
    const MAX_LINK_CHIPS = 3
    /**
     * Build tag of the browser half. Host code and client code are reloaded by
     * different mechanisms (restart vs. hot reload), so "which one am I looking
     * at" needs an answer that the bundle itself carries.
     */
    const UI_REV = 'ui16'

    // ------------------------------------------------------------------ 文案

    const zh = {
      'entry.label': '待办',
      'panel.title': '全局待办',
      'panel.subtitle': '跨会话一份清单，人和 Agent 都能加',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.add': '添加',
      'action.more': '更多字段',
      'action.less': '收起字段',
      'action.detail': '详情',
      'action.hide': '收起',
      'action.dispatch': '交给 Agent',
      'action.dispatchCurrent': '交给：当前对话',
      'action.dispatchAuto': '交给：自动（优先已绑定）',
      'action.dispatchNew': '交给：开新对话',
      'action.dispatchBound': '交给：只发给已绑定对话',
      'action.done': '完成',
      'action.reopen': '标回未完成',
      'action.doing': '标为进行中',
      'action.remove': '删除',
      'action.removeConfirm': '确认删除',
      'action.unlink': '摘掉',
      'action.addLink': '挂上',
      'action.open': '打开',
      'action.copy': '复制路径',
      'action.copied': '已复制',
      'action.undo': '撤销',
      'action.menu': '更多操作',
      'action.capture': '从本对话抓取',
      'action.captureHint': '让当前对话把需要跟进的事一次登记进来',
      'action.captureShort': '抓取',
      'autoCollect.label': '自动获取',
      'autoCollect.hint': '开启后：你在某个对话里说完一轮，如果它 {n} 分钟没被问过、且这一轮正常收尾，就自动问它一次「有没有要跟进的事」。关掉就完全靠你和 Agent 手动记。',
      'notice.autoCollectOn': '已开启自动获取：每 {n} 分钟最多问一次',
      'notice.autoCollectOff': '已关闭自动获取',
      'action.captureGroupHint': '让这个对话里的 Agent 把该跟进的事登记成待办（结果归到这个对话下）',
      'notice.dispatched': '已交给「{title}」——去那个对话看它的进展',
      'notice.dispatchedAnonymous': '已交给当前对话（{id}）——去那个对话看它的进展',
      'notice.openIt': '打开那个对话',
      'notice.captured': '已让「{title}」抓取，稍等片刻清单会出现新条目',
      'notice.capturedAnonymous': '已让当前对话抓取，稍等片刻清单会出现新条目',
      'action.pickDir': '选择',
      'action.followSession': '跟随当前会话',
      'field.target': '发给',
      'target.current': '当前对话',
      'target.label': '交给',
      'target.auto': '自动（已绑定 → 最近说过话 → 新开）',
      'target.newConversation': '＋ 开一个新对话（在工作区）',
      'target.newInWorkspace': '＋ 新对话 · {title}',
      'target.archived': '已归档',
      'target.recent': '（最近说过话）',
      'target.pick': '选择要交给的对话',
      'target.none': '（没读到对话列表 —— 请刷新页面）',
      'target.currentNamed': '当前对话「{title}」',
      'target.currentUnknown': '当前对话（Host 取你最近说话的对话）',
      'field.dir': '工作目录',
      'dir.none': '未确定',
      'dir.fromSession': '（跟随当前会话）',
      'dir.picked': '（已指定）',
      'action.save': '保存',
      'action.cancel': '取消',
      'filter.all': '全部',
      'filter.active': '未完成',
      'filter.doing': '进行中',
      'filter.done': '已完成',
      'filter.overdue': '逾期',
      'field.title': '要做什么？回车即存',
      'field.description': '描述：验收标准、已知的坑…',
      'field.links': '相关文档与地址，一行一个（/绝对路径 或 https://…）',
      'field.tags': '标签，逗号分隔',
      'field.priority': '优先级',
      'field.due': '截止时间',
      'field.linkValue': '文档绝对路径或网址',
      'field.linkTitle': '给它起个短名字（可空）',
      'field.search': '搜标题、描述、标签、附件…',
      'priority.low': 'P3 低',
      'priority.normal': 'P2 常规',
      'priority.high': 'P1 高',
      'priority.urgent': 'P0 紧急',
      'group.by': '分组',
      'group.conversation': '对话',
      'group.time': '时间',
      'group.level': '级别',
      'group.manual': '手动添加',
      'group.conversation': '对话',
      'group.other': '其他',
      'group.items': '{n} 条',
      'group.thisConversation': '本对话',
      'group.overdue': '逾期',
      'group.today': '今天',
      'group.soon': '接下来',
      'group.later': '以后',
      'group.none': '没有截止时间',
      'group.done': '已完成',
      'group.cancelled': '已取消',
      'empty.none': '还没有待办。上面写一句，回车就记下了。',
      'empty.filtered': '这个筛选下没有待办。',
      'meta.added': '加入于',
      'meta.due': '截止',
      'meta.overdue': '逾期 {n} 天',
      'meta.today': '今天到期',
      'meta.links': '{n} 个附件',
      'meta.by.human': '人加的',
      'meta.by.agent': 'Agent 加的',
      'meta.session.live': '会话在跑',
      'meta.session.bound': '已绑定会话',
      'meta.session.noDir': '会话无工作目录',
      'meta.dispatchFailed': '上次派发失败',
      'detail.description': '描述',
      'detail.noDescription': '没有描述。',
      'detail.links': '相关文档与地址',
      'detail.completion': '完成记录',
      'detail.notes': '进展记录',
      'note.placeholder': '记一条进展：做到哪了、卡在哪、需要谁做什么',
      'note.add': '记录进展',
      'note.by.agent': 'Agent',
      'note.by.human': '人',
      'note.none': '还没有进展记录。',
      'note.count': '{n} 条进展',
      'note.latest': '最新进展：{text}',
      'link.missing': '文件不在了（可能被移动或删除）',
      'search.hint': '支持 tag:发布 / is:overdue / has:link / level:p0，空格分隔多个条件',
      'completion.by.agent': 'Agent 完成',
      'completion.by.human': '人工完成',
      'completion.auto': '会话收尾时自动记录',
      'completion.none': '没有留下完成说明',
      'detail.noLinks': '没有附件。可以挂本地文档的绝对路径，或网页地址。',
      'detail.activity': '动态',
      'detail.lastDispatch': '最近派发',
      'meta.origin': '写于 {dir}',
      'meta.completed': '完成于 {when}',
      'detail.edit': '编辑',
      'error.prefix': '出错了',
      'counts.active': '未完成 {n}',
      'counts.overdue': '逾期 {n}',
      'counts.done': '已完成 {n}',
      'store.at': '数据：{file}',
      'loading': '载入中…',
      'deleted': '已删除「{title}」',
      'hint.keys': '快捷键：/ 搜索 · n 新建 · Esc 收起',
      'justNow': '刚刚',
      'minutesAgo': '{n} 分钟前',
      'hoursAgo': '{n} 小时前',
      'daysAgo': '{n} 天前',
    }

    const en = {
      'entry.label': 'Todos',
      'panel.title': 'Global todos',
      'panel.subtitle': 'One list across sessions, written by you and the agent',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.add': 'Add',
      'action.more': 'More fields',
      'action.less': 'Fewer fields',
      'action.detail': 'Details',
      'action.hide': 'Hide',
      'action.dispatch': 'Hand to agent',
      'action.dispatchCurrent': 'Hand to: this conversation',
      'action.dispatchAuto': 'Hand to: automatic (bound first)',
      'action.dispatchNew': 'Hand to: a new conversation',
      'action.dispatchBound': 'Dispatch: bound session only',
      'action.done': 'Done',
      'action.reopen': 'Reopen',
      'action.doing': 'Start',
      'action.remove': 'Delete',
      'action.removeConfirm': 'Confirm delete',
      'action.unlink': 'Remove',
      'action.addLink': 'Attach',
      'action.open': 'Open',
      'action.copy': 'Copy path',
      'action.copied': 'Copied',
      'action.undo': 'Undo',
      'action.menu': 'More actions',
      'action.capture': 'Collect from this chat',
      'action.captureHint': 'Ask the current conversation to record what needs following up',
      'action.captureShort': 'Collect',
      'autoCollect.label': 'Auto-collect',
      'autoCollect.hint': 'When on: after a clean turn in a conversation you are in, that conversation is asked once whether anything needs following up — at most once every {n} minutes.',
      'notice.autoCollectOn': 'Auto-collect on: asked at most once every {n} minutes',
      'notice.autoCollectOff': 'Auto-collect off',
      'action.captureGroupHint': 'Ask this conversation to record what needs following up (the items land under it)',
      'notice.dispatched': 'Handed to “{title}” — watch it there',
      'notice.dispatchedAnonymous': 'Handed to the current conversation ({id}) — watch it there',
      'notice.openIt': 'Open it',
      'notice.captured': 'Asked “{title}” to collect — new items will show up shortly',
      'notice.capturedAnonymous': 'Asked the current conversation to collect — new items will show up shortly',
      'action.pickDir': 'Choose',
      'action.followSession': 'Follow this conversation',
      'field.target': 'To',
      'target.current': 'this conversation',
      'target.label': 'Hand to',
      'target.auto': 'Automatic (bound → last written → new)',
      'target.newConversation': '+ a new conversation (inherit the workspace)',
      'target.newInWorkspace': '+ new conversation · {title}',
      'target.archived': 'archived',
      'target.recent': '(you wrote here last)',
      'target.pick': 'Pick the conversation to hand this to',
      'target.none': '(no conversation list — reload the page)',
      'target.currentNamed': 'this conversation — {title}',
      'target.currentUnknown': 'this conversation (the one you last wrote in)',
      'field.dir': 'Working directory',
      'dir.none': 'not set',
      'dir.fromSession': '(from this conversation)',
      'dir.picked': '(chosen)',
      'meta.origin': 'from {dir}',
      'meta.completed': '完成于 {when}',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'filter.all': 'All',
      'filter.active': 'Open',
      'filter.doing': 'Doing',
      'filter.done': 'Done',
      'filter.overdue': 'Overdue',
      'field.title': 'What needs doing? Enter to save',
      'field.description': 'Description: acceptance, known traps…',
      'field.links': 'Documents and links, one per line (/abs/path or https://…)',
      'field.tags': 'Tags, comma separated',
      'field.priority': 'Priority',
      'field.due': 'Due',
      'field.linkValue': 'Absolute document path or URL',
      'field.linkTitle': 'Short label (optional)',
      'field.search': 'Search title, description, tags, attachments…',
      'priority.low': 'P3 Low',
      'priority.normal': 'P2 Normal',
      'priority.high': 'P1 High',
      'priority.urgent': 'P0 Urgent',
      'group.by': 'Group',
      'group.time': 'Time',
      'group.level': 'Level',
      'group.manual': 'Added by hand',
      'group.other': 'Other',
      'group.items': '{n} items',
      'group.thisConversation': 'this conversation',
      'group.overdue': 'Overdue',
      'group.today': 'Today',
      'group.soon': 'Next up',
      'group.later': 'Later',
      'group.none': 'No due date',
      'group.done': 'Done',
      'group.cancelled': 'Cancelled',
      'empty.none': 'No todos yet. Write one above and press Enter.',
      'empty.filtered': 'Nothing matches this filter.',
      'meta.added': 'added',
      'meta.due': 'due',
      'meta.overdue': '{n} d overdue',
      'meta.today': 'due today',
      'meta.links': '{n} attachments',
      'meta.by.human': 'by human',
      'meta.by.agent': 'by agent',
      'meta.session.live': 'session running',
      'meta.session.bound': 'session bound',
      'meta.session.noDir': 'session has no directory',
      'meta.dispatchFailed': 'last hand-off failed',
      'detail.description': 'Description',
      'detail.noDescription': 'No description.',
      'detail.links': 'Documents and links',
      'detail.noLinks': 'No attachments. Attach an absolute document path, or a URL.',
      'detail.activity': 'Activity',
      'detail.lastDispatch': 'Last hand-off',
      'detail.edit': 'Edit',
      'error.prefix': 'Error',
      'counts.active': 'Open {n}',
      'counts.overdue': 'Overdue {n}',
      'counts.done': 'Done {n}',
      'store.at': 'Data: {file}',
      'loading': 'Loading…',
      'deleted': 'Deleted “{title}”',
      'hint.keys': 'Keys: / search · n new · Esc collapse',
      'justNow': 'just now',
      'minutesAgo': '{n} min ago',
      'hoursAgo': '{n} h ago',
      'daysAgo': '{n} d ago',
    }

    const DICTS = { zh, en }

    /**
     * @param {'zh' | 'en'} lang
     * @param {string} key
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    function translate(lang, key, params) {
      let out = DICTS[lang]?.[key] ?? DICTS.zh[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) out = out.replace(`{${name}}`, String(value))
      return out
    }

    /**
     * Resolve the active language defensively: the locale snapshot shape is the
     * host's business, and an unrecognised value must fall back, not throw.
     *
     * @param {object} ctx
     * @returns {'zh' | 'en'}
     */
    function resolveLang(ctx) {
      try {
        const snapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
        const raw = snapshot?.locale ?? snapshot?.id ?? snapshot?.language ?? snapshot?.current ?? ''
        const text = typeof raw === 'string' ? raw.toLowerCase() : ''
        if (text.startsWith('zh')) return 'zh'
        if (text.startsWith('en')) return 'en'
      } catch {
        /* fall through */
      }
      return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '') ? 'zh' : 'en'
    }

    // ------------------------------------------------------------------ 工具

    /** @returns {string} a short, human age string */
    function ageText(lang, then, now) {
      const delta = Math.max(0, now - then)
      const minutes = Math.floor(delta / 60000)
      if (minutes < 1) return translate(lang, 'justNow')
      if (minutes < 60) return translate(lang, 'minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return translate(lang, 'hoursAgo', { n: hours })
      return translate(lang, 'daysAgo', { n: Math.floor(hours / 24) })
    }

    /** @returns {string} compact absolute local time, e.g. `10-13 22:47` */
    function absoluteTime(then) {
      const date = new Date(then)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** @returns {string} a `datetime-local` value for an ISO string */
    function toLocalInput(iso) {
      if (iso === null || iso === undefined || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** @returns {number} whole days between `then` and now, at least 1 */
    function daysLate(iso, now) {
      const due = Date.parse(iso)
      if (!Number.isFinite(due)) return 0
      return Math.max(1, Math.ceil((now - due) / 86400000))
    }

    /** @returns {boolean} whether two dates fall on the same local day */
    function sameLocalDay(a, b) {
      const left = new Date(a)
      const right = new Date(b)
      return (
        left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
      )
    }

    /** Where the panel remembers a directory the user picked for hand-offs. */
    const DIR_KEY = 'dsh-global-todo:dispatch-dir'

    /** Where the panel remembers an explicitly chosen hand-off target. */
    const TARGET_KEY = 'dsh-global-todo:target'

    /** @returns {string} a stored session id, 'new', or '' for automatic */
    function readStoredTarget() {
      try {
        return window.localStorage.getItem(TARGET_KEY) ?? ''
      } catch {
        return ''
      }
    }

    /** @param {string} value */
    function storeStoredTarget(value) {
      try {
        if (value === '') window.localStorage.removeItem(TARGET_KEY)
        else window.localStorage.setItem(TARGET_KEY, value)
      } catch {
        /* storage is a nicety */
      }
    }

    /** Where the panel remembers the grouping dimension. */
    const GROUP_KEY = 'dsh-global-todo:group-mode'
    const GROUP_MODES = Object.freeze(['conversation', 'time', 'level'])

    /** @returns {'conversation' | 'time' | 'level'} */
    function readStoredGroupMode() {
      try {
        const stored = window.localStorage.getItem(GROUP_KEY) ?? ''
        return GROUP_MODES.includes(stored) ? stored : 'conversation'
      } catch {
        return 'conversation'
      }
    }

    /** @param {string} mode */
    function storeStoredGroupMode(mode) {
      try {
        window.localStorage.setItem(GROUP_KEY, mode)
      } catch {
        /* storage is a nicety */
      }
    }

    /** @returns {string} the remembered hand-off directory, or '' */
    function readStoredDir() {
      try {
        return window.localStorage.getItem(DIR_KEY) ?? ''
      } catch {
        return ''
      }
    }

    /** @param {string} dir - '' clears the memory */
    function storeStoredDir(dir) {
      try {
        if (dir === '') window.localStorage.removeItem(DIR_KEY)
        else window.localStorage.setItem(DIR_KEY, dir)
      } catch {
        /* storage is a nicety; a private window must not break dispatch */
      }
    }

    /** @returns {string} the last two path segments, for a readable chip */
    function shortPath(value) {
      const parts = String(value).split(/[\\/]/).filter((part) => part !== '')
      if (parts.length <= 2) return String(value)
      return `…/${parts.slice(-2).join('/')}`
    }

    /**
     * A cheap identity for a sessions snapshot: ids, titles and who retains them.
     *
     * The point is to keep the *previous object* when nothing that matters changed,
     * so a store that emits a fresh snapshot per message cannot re-render the panel
     * forever.
     *
     * @param {unknown} snapshot
     * @returns {string}
     */
    function sessionRowSignature(snapshot) {
      const rows = snapshot?.byId ?? {}
      return Object.keys(rows)
        .sort()
        .map((id) => {
          const row = rows[id] ?? {}
          const title = typeof row.title === 'string' ? row.title : ''
          const main = row?.retainedBy?.mainView ?? 0
          return `${id}:${title}:${main}`
        })
        .join('|')
    }

    /** @param {unknown} previous @param {unknown} next @returns {boolean} */
    function sameSessionRows(previous, next) {
      if (previous === next) return true
      if (previous === null || next === null) return false
      try {
        return sessionRowSignature(previous) === sessionRowSignature(next)
      } catch {
        return false
      }
    }

    /** One network error shape for the whole panel. */
    class ApiError extends Error {
      constructor(reason, message) {
        super(message ?? reason ?? 'request failed')
        this.reason = reason ?? 'internal'
      }
    }

    /**
     * @param {string} path - route suffix, e.g. `list`
     * @param {{ method?: string, body?: object, query?: Record<string, string> }} [options]
     */
    async function call(path, options = {}) {
      const query = options.query === undefined ? '' : `?${new URLSearchParams(options.query).toString()}`
      const response = await fetch(`${API}/${path}${query}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new ApiError('internal', `HTTP ${response.status}（响应不是 JSON）`)
      }
      if (payload?.ok === true) return payload.data
      throw new ApiError(payload?.reason, payload?.error ?? `HTTP ${response.status}`)
    }

    /**
     * The session the user is standing in, when the host exposes it.
     *
     * The panel lives in a root-scoped slot with no session of its own, and the
     * client service surface has no "current session" accessor, so the panel
     * does not pretend to know one. `current` stays a host-side dispatch mode
     * for callers that do know; the panel uses `auto` / `new` / `bound`.
     *
     * @returns {string}
     */
    function activeSessionId() {
      return ''
    }

    // ------------------------------------------------------------------ 图标

    /**
     * One inline icon set. Line icons keep the panel quiet next to a dense list.
     *
     * @param {{ name: string, size?: number }} props
     */
    function Icon(props) {
      const size = props.size ?? 14
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }
      if (props.name === 'check') return h('svg', common, h('path', { d: 'M3.2 8.4l3 3 6.6-7' }))
      if (props.name === 'plus') return h('svg', common, h('path', { d: 'M8 3.4v9.2M3.4 8h9.2' }))
      if (props.name === 'refresh') {
        return h(
          'svg',
          common,
          h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
          h('path', { d: 'M13.2 2.2v3.2H10' }),
        )
      }
      if (props.name === 'search') return h('svg', common, h('circle', { cx: 7.2, cy: 7.2, r: 4.3 }), h('path', { d: 'M10.5 10.5l3 3' }))
      if (props.name === 'link') {
        return h(
          'svg',
          common,
          h('path', { d: 'M6.6 9.4l2.8-2.8' }),
          h('path', { d: 'M7.4 5.2l1-1a2.7 2.7 0 0 1 3.8 3.8l-1 1' }),
          h('path', { d: 'M8.6 10.8l-1 1a2.7 2.7 0 0 1-3.8-3.8l1-1' }),
        )
      }
      if (props.name === 'doc') {
        return h(
          'svg',
          common,
          h('path', { d: 'M4 1.8h5l3 3v9.4H4z' }),
          h('path', { d: 'M9 1.8v3h3' }),
          h('path', { d: 'M6 8.4h4M6 10.8h4' }),
        )
      }
      if (props.name === 'play') return h('svg', common, h('path', { d: 'M4.6 3.2l7.4 4.8-7.4 4.8z' }))
      if (props.name === 'trash') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.8 4.4h10.4' }),
          h('path', { d: 'M6 4.4V3h4v1.4' }),
          h('path', { d: 'M4.2 4.4l.7 8.4h6.2l.7-8.4' }),
        )
      }
      if (props.name === 'kebab') {
        return h(
          'svg',
          { ...common, strokeWidth: 0 },
          h('circle', { cx: 8, cy: 3.6, r: 1.2, fill: 'currentColor' }),
          h('circle', { cx: 8, cy: 8, r: 1.2, fill: 'currentColor' }),
          h('circle', { cx: 8, cy: 12.4, r: 1.2, fill: 'currentColor' }),
        )
      }
      if (props.name === 'clock') return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.6 }), h('path', { d: 'M8 4.8V8l2.2 1.4' }))
      if (props.name === 'chevron') return h('svg', common, h('path', { d: 'M5.6 3.8L10 8l-4.4 4.2' }))
      if (props.name === 'flag') return h('svg', common, h('path', { d: 'M4 14V2.6h7l-1.2 2.8L11 8.2H4' }))
      return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.4 }))
    }

    // ------------------------------------------------------------------ 样式

    const CSS = `
.gt-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); font-size: 13px; }
.gt-inner { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 980px;
  margin: 0 auto; padding: 16px 20px 28px; min-height: 0; flex: 1; }
.gt-head { display: flex; align-items: flex-start; gap: 12px; }
.gt-headline { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gt-title { font-size: 17px; font-weight: 650; letter-spacing: .2px; }
.gt-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gt-spacer { flex: 1; }
.gt-iconbtn { display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  background: transparent; color: var(--dsw-alias-label-secondary); border: 1px solid transparent;
  border-radius: 8px; padding: 5px 7px; font: inherit; cursor: pointer; }
.gt-iconbtn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.gt-btn { display: inline-flex; align-items: center; gap: 5px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  padding: 4px 9px; font: inherit; cursor: pointer; white-space: nowrap; }
.gt-btn:hover { border-color: var(--dsw-alias-border-l2); }
.gt-btn:disabled { opacity: .5; cursor: default; }
.gt-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); font-weight: 600; }
.gt-btn-primary:hover { border-color: var(--dsw-alias-brand-primary); }
.gt-btn-quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.gt-btn-quiet:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.gt-btn-danger { color: var(--dsw-alias-state-error-primary); }
.gt-btn-danger:hover { border-color: var(--dsw-alias-state-error-primary); }
.gt-btn-brand { background: transparent; border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-brand-primary); font-weight: 550; }
.gt-btn-brand:hover { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); }
.gt-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 12px 14px; }
.gt-new { display: flex; flex-direction: column; gap: 10px; }
.gt-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gt-input, .gt-select, .gt-textarea { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 9px; font: inherit; }
.gt-input:focus, .gt-select:focus, .gt-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.gt-input { flex: 1; min-width: 120px; }
.gt-input-sm { flex: 0 1 auto; min-width: 96px; }
.gt-textarea { width: 100%; min-height: 54px; resize: vertical; font-family: inherit; }
.gt-select { padding: 6px 7px; }
.gt-search { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 160px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  padding: 0 9px; color: var(--dsw-alias-label-secondary); }
.gt-search input { flex: 1; background: transparent; border: none; color: var(--dsw-alias-label-primary);
  font: inherit; padding: 6px 0; min-width: 0; }
.gt-search input:focus { outline: none; }
.gt-search:focus-within { border-color: var(--dsw-alias-brand-primary); }
.gt-kbd { font-size: 10.5px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  padding: 0 4px; color: var(--dsw-alias-label-secondary); }
.gt-dir { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; padding: 3px 6px 3px 8px; max-width: 560px; }
.gt-dir-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.gt-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gt-seg { display: inline-flex; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; padding: 2px; gap: 2px; }
.gt-seg button { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit;
  border-radius: 7px; padding: 3px 10px; cursor: pointer; }
.gt-seg button[data-on="1"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.gt-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.gt-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; padding: 2px 8px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-secondary); }
button.gt-chip { cursor: pointer; font-family: inherit; }
button.gt-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
button.gt-chip[data-on="1"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-1); }
.gt-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.gt-chip-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.gt-chip-ok { color: var(--dsw-alias-state-success-primary); }
.gt-groups { display: flex; flex-direction: column; gap: 14px; overflow: auto; min-height: 0; flex: 1; }
.gt-group { display: flex; flex-direction: column; gap: 6px; }
.gt-group-head { display: flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary);
  font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; padding: 0 2px; }
.gt-group-head button { border: none; background: transparent; color: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; font: inherit; padding: 2px 0; }
.gt-group-head svg { transition: transform .12s ease; transform: rotate(90deg); }
.gt-group[data-collapsed="1"] .gt-group-head svg { transform: rotate(0deg); }
.gt-group-action { margin-left: 4px; border: 1px solid transparent; background: transparent; color: inherit;
  border-radius: 999px; padding: 1px 8px; font: inherit; font-size: 11px; letter-spacing: .04em; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; opacity: .72; transition: opacity .12s ease; }
.gt-group:hover .gt-group-action, .gt-group-action:focus-visible { opacity: 1; }
.gt-group-action:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.gt-group-count { color: var(--dsw-alias-label-secondary); }
.gt-group-label { color: var(--dsw-alias-label-primary); font-weight: 600; text-transform: none;
  letter-spacing: 0; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-level { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; padding: 0 5px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.gt-level[data-level="urgent"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.gt-level[data-level="high"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.gt-level[data-level="low"] { color: var(--dsw-alias-label-secondary); }
.gt-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-success-primary);
  display: inline-block; }
.gt-here { font-size: 10.5px; padding: 0 5px; border-radius: 999px; border: 1px solid var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary); }
.gt-list { display: flex; flex-direction: column; gap: 6px; }
.gt-item { position: relative; display: flex; flex-direction: column; gap: 9px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px; padding: 11px 13px; }
.gt-item:hover { border-color: var(--dsw-alias-border-l2); }
.gt-item[data-status="doing"] { border-left: 2px solid var(--dsw-alias-brand-primary); }
.gt-item[data-overdue="1"] { border-left: 2px solid var(--dsw-alias-state-error-primary); }
.gt-item[data-status="done"], .gt-item[data-status="cancelled"] { opacity: .72; }
.gt-item[data-open="1"] { border-color: var(--dsw-alias-brand-primary); }
.gt-item-head { display: flex; gap: 10px; align-items: flex-start; }
.gt-check { flex: 0 0 auto; width: 19px; height: 19px; margin-top: 1px; border-radius: 999px; cursor: pointer;
  border: 1.4px solid var(--dsw-alias-border-l2); background: transparent; color: transparent;
  display: inline-flex; align-items: center; justify-content: center; padding: 0; }
.gt-check:hover { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.gt-check[data-on="1"] { border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-bg-base); }
.gt-item-body { flex: 1; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.gt-item-title { font-weight: 600; font-size: 13.5px; word-break: break-word; line-height: 1.45; }
.gt-item[data-status="done"] .gt-item-title, .gt-item[data-status="cancelled"] .gt-item-title {
  text-decoration: line-through; color: var(--dsw-alias-label-secondary); }
.gt-meta { display: flex; gap: 5px 8px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-size: 11.5px;
  align-items: center; }
.gt-meta > span { display: inline-flex; align-items: center; }
.gt-meta-sep { opacity: .45; }
.gt-tag { color: var(--dsw-alias-brand-primary); }
/* The dispatch action stays put: hiding the only way to hand work to an agent
   behind a hover makes a lone todo look like it can do nothing. */
.gt-actions { display: flex; gap: 4px; align-items: center; flex: 0 0 auto; }
.gt-attach { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.gt-attach .gt-chip { max-width: 280px; color: var(--dsw-alias-label-secondary); }
.gt-attach a.gt-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.gt-attach-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-menu { position: absolute; top: 40px; right: 10px; z-index: 3; min-width: 168px; display: flex;
  flex-direction: column; padding: 4px; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.gt-menu button { display: flex; align-items: center; gap: 8px; text-align: left; border: none;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; padding: 6px 8px;
  border-radius: 7px; cursor: pointer; }
.gt-menu button:hover { background: var(--dsw-alias-bg-layer-2); }
.gt-menu button[data-danger="1"] { color: var(--dsw-alias-state-error-primary); }
.gt-detail { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--dsw-alias-border-l1);
  padding-top: 10px; margin-top: 2px; }
.gt-section { display: flex; flex-direction: column; gap: 5px; }
.gt-completion { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.gt-section-title { color: var(--dsw-alias-label-secondary); font-size: 11.5px; text-transform: uppercase;
  letter-spacing: .06em; }
.gt-pre { white-space: pre-wrap; word-break: break-word; margin: 0; line-height: 1.6; }
.gt-muted { color: var(--dsw-alias-label-secondary); }
.gt-links { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.gt-link { display: flex; gap: 8px; align-items: center; padding: 4px 0; min-width: 0; }
.gt-link-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.gt-link a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.gt-link a:hover { text-decoration: underline; }
.gt-link-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.gt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gt-banner { border-radius: 9px; padding: 8px 11px; border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gt-activity { display: flex; flex-direction: column; gap: 3px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.gt-empty { display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); padding: 42px 16px; text-align: center; flex: 1; }
.gt-empty-title { font-size: 14px; color: var(--dsw-alias-label-primary); }
.gt-foot { color: var(--dsw-alias-label-secondary); font-size: 11px; display: flex; gap: 10px; flex-wrap: wrap;
  align-items: center; }
.gt-toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 5;
  display: flex; align-items: center; gap: 12px; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 9px 13px;
  color: var(--dsw-alias-label-primary); }
.gt-a11y { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`

    // ------------------------------------------------------------------ 小组件

    /** @param {{ value: string, options: Array<{value: string, label: string}>, onChange: Function, label: string }} props */
    function Segmented(props) {
      return h(
        'div',
        { className: 'gt-seg', role: 'group', 'aria-label': props.label },
        props.options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'data-on': props.value === option.value ? '1' : '0',
              'aria-pressed': props.value === option.value,
              onClick: () => props.onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * A row action menu. Closes on Escape, on an outside click and after an
     * action, so it can never strand the panel in an open-menu state.
     *
     * @param {{ items: Array<{ key: string, label: string, danger?: boolean, icon?: string, onSelect: Function }>, label: string }} props
     */
    function Menu(props) {
      const [open, setOpen] = useState(false)
      const root = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined') return undefined
        const onDocumentDown = (event) => {
          if (root.current !== null && !root.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocumentDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDocumentDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      return h(
        'div',
        { ref: root, style: { position: 'relative' } },
        h(
          'button',
          {
            type: 'button',
            className: 'gt-iconbtn',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            title: props.label,
            'aria-label': props.label,
            onClick: () => setOpen((value) => !value),
          },
          h(Icon, { name: 'kebab', size: 15 }),
        ),
        open
          ? h(
              'div',
              { className: 'gt-menu', role: 'menu' },
              props.items.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    role: 'menuitem',
                    'data-danger': item.danger === true ? '1' : '0',
                    onClick: () => {
                      setOpen(false)
                      item.onSelect()
                    },
                  },
                  item.icon === undefined ? null : h(Icon, { name: item.icon, size: 13 }),
                  item.label,
                ),
              ),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ 分组

    /**
     * Bucket todos the way a person plans a day: what is late, what is today,
     * what is next, what has no date, and what is already settled.
     *
     * @param {object[]} todos
     * @param {number} now
     * @returns {Array<{ key: string, todos: object[] }>}
     */
    /** Levels, most urgent first — the order a level view and a conversation badge use. */
    const LEVEL_ORDER = ['urgent', 'high', 'normal', 'low']

    /** @returns {number} the most urgent level present in `list` */
    function topLevel(list) {
      for (const level of LEVEL_ORDER) {
        if (list.some((todo) => todo.priority === level)) return level
      }
      return 'normal'
    }

    /**
     * Order inside a group: unfinished first, then by urgency and due time.
     *
     * @param {object[]} list
     * @param {number} now
     * @returns {object[]} a new array
     */
    function orderWithin(list, now) {
      const rank = (todo) => {
        if (todo.status === 'done') return 3
        if (todo.status === 'cancelled') return 4
        if (isOverdueTodo(todo, now)) return 0
        return 1
      }
      const priorityRank = (todo) => LEVEL_ORDER.indexOf(todo.priority)
      return [...list].sort((left, right) => {
        const byRank = rank(left) - rank(right)
        if (byRank !== 0) return byRank
        const byPriority = priorityRank(left) - priorityRank(right)
        if (byPriority !== 0) return byPriority
        const leftDue = left.dueAt === null || left.dueAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.dueAt)
        const rightDue = right.dueAt === null || right.dueAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.dueAt)
        if (leftDue !== rightDue) return leftDue - rightDue
        return right.createdAt - left.createdAt
      })
    }

    /** @returns {boolean} whether a todo is past its due time */
    function isOverdueTodo(todo, now) {
      if (todo.dueAt === null || todo.dueAt === undefined) return false
      const due = Date.parse(todo.dueAt)
      return Number.isFinite(due) && due < now && todo.status !== 'done' && todo.status !== 'cancelled'
    }

    /**
     * Group the list by the dimension the user picked.
     *
     * `conversation` is the default: everything one agent conversation submitted
     * collapses into a single entry, which is what keeps a list that a few
     * 「抓一下待办」 runs filled up from reading like a wall of rows.
     *
     * @param {object[]} todos
     * @param {number} now
     * @param {'conversation' | 'time' | 'level'} mode
     * @param {Record<string, string>} titles - session id → conversation title
     * @param {(key: string, params?: object) => string} translate - the panel's dictionary
     * @returns {{ key: string, label: string, todos: object[], level: string, live: boolean, collapsed: boolean }[]}
     */
    function groupTodos(todos, now, mode = 'conversation', titles = {}, translate = (key) => key) {
      if (mode === 'level') return levelGroups(todos, now, translate)
      if (mode === 'conversation') return conversationGroups(todos, now, titles, translate)
      return timeGroups(todos, now, translate)
    }

    /** @returns {object[]} one entry per source conversation */
    function conversationGroups(todos, now, titles, translate) {
      const buckets = new Map()
      for (const todo of todos) {
        const key = typeof todo.originSessionId === 'string' && todo.originSessionId !== '' ? todo.originSessionId : '__manual__'
        const bucket = buckets.get(key)
        if (bucket === undefined) buckets.set(key, [todo])
        else bucket.push(todo)
      }
      return [...buckets.entries()]
        .map(([key, list]) => {
          const ordered = orderWithin(list, now)
          const title = titles[key]
          return {
            key: `conv:${key}`,
            label:
              key === '__manual__'
                ? translate('group.manual')
                : typeof title === 'string' && title !== ''
                  ? title
                  : `${translate('group.conversation')} …${key.slice(-8)}`,
            todos: ordered,
            level: topLevel(ordered),
            live: ordered.some((todo) => todo.sessionAlive === true),
            sessionId: key === '__manual__' ? undefined : key,
            // A conversation that submitted several items is one line until asked.
            collapsed: ordered.length > 1,
            recent: ordered.reduce((newest, todo) => Math.max(newest, todo.createdAt), 0),
          }
        })
        .sort((left, right) => right.recent - left.recent)
    }

    /** @returns {object[]} one entry per level */
    function levelGroups(todos, now, translate) {
      return LEVEL_ORDER.map((level) => ({
        key: `level:${level}`,
        label: translate(`priority.${level}`),
        todos: orderWithin(todos.filter((todo) => todo.priority === level), now),
        level,
        live: false,
        collapsed: false,
      })).filter((group) => group.todos.length > 0)
    }

    /** @returns {object[]} the original time buckets */
    function timeGroups(todos, now, translate) {
      const groups = []
      const built = groupByTime(todos, now)
      for (const group of built) {
        groups.push({
          key: `time:${group.key}`,
          label: translate(`group.${group.key}`),
          todos: orderWithin(group.todos, now),
          level: topLevel(group.todos),
          live: group.todos.some((todo) => todo.sessionAlive === true),
          collapsed: false,
        })
      }
      return groups
    }

    /** @returns {object[]} raw time buckets, keys as in the dictionaries */
    function groupByTime(todos, now) {
      const buckets = new Map([
        ['overdue', []],
        ['today', []],
        ['soon', []],
        ['later', []],
        ['none', []],
        ['done', []],
        ['cancelled', []],
      ])
      const week = now + 7 * 86400000
      for (const todo of todos) {
        if (todo.status === 'done') {
          buckets.get('done').push(todo)
          continue
        }
        if (todo.status === 'cancelled') {
          buckets.get('cancelled').push(todo)
          continue
        }
        if (todo.dueAt === null || todo.dueAt === undefined) {
          buckets.get('none').push(todo)
          continue
        }
        const due = Date.parse(todo.dueAt)
        if (!Number.isFinite(due)) {
          buckets.get('none').push(todo)
          continue
        }
        if (due < now) buckets.get('overdue').push(todo)
        else if (sameLocalDay(due, now)) buckets.get('today').push(todo)
        else if (due <= week) buckets.get('soon').push(todo)
        else buckets.get('later').push(todo)
      }
      return [...buckets.entries()]
        .filter(([, list]) => list.length > 0)
        .map(([key, list]) => ({ key, todos: list }))
    }

    // ------------------------------------------------------------------ 单条待办

    /**
     * @param {{ todo: object, lang: string, busy: boolean, open: boolean,
     *   dispatchLabel: string, onAction: Function, onToggleOpen: Function }} props
     */
    function TodoItem(props) {
      const { todo, lang, busy, open, dispatchLabel, onAction, onToggleOpen } = props
      const t = (key, params) => translate(lang, key, params)
      const now = Date.now()
      const done = todo.status === 'done'
      const cancelled = todo.status === 'cancelled'
      const overdue = todo.dueAt !== null && Date.parse(todo.dueAt) < now && !done && !cancelled
      const [confirming, setConfirming] = useState(false)
      const [copied, setCopied] = useState('')
      // The note box belongs to the row that is open, so its draft lives here.
      const [noteDraft, setNoteDraft] = useState('')
      const [linkValue, setLinkValue] = useState('')
      const [linkTitle, setLinkTitle] = useState('')
      const [draft, setDraft] = useState({
        title: todo.title,
        description: todo.description,
        due: toLocalInput(todo.dueAt),
        priority: todo.priority,
      })

      // Re-seed the edit draft whenever the record changes underneath us.
      useEffect(() => {
        setDraft({
          title: todo.title,
          description: todo.description,
          due: toLocalInput(todo.dueAt),
          priority: todo.priority,
        })
      }, [todo.id, todo.updatedAt, todo.title, todo.description, todo.dueAt, todo.priority])

      const dirty =
        draft.title !== todo.title ||
        draft.description !== todo.description ||
        draft.priority !== todo.priority ||
        draft.due !== toLocalInput(todo.dueAt)

      const meta = []
      meta.push(
        h('span', { key: 'added', title: new Date(todo.createdAt).toLocaleString() }, `${t('meta.added')} ${absoluteTime(todo.createdAt)}（${ageText(lang, todo.createdAt, now)}）`),
      )
      if (todo.priority !== 'normal') {
        meta.push(
          h(
            'span',
            { key: 'prio', className: 'gt-level', 'data-level': todo.priority },
            h(Icon, { name: 'flag', size: 11 }),
            ` ${t(`priority.${todo.priority}`)}`,
          ),
        )
      }
      if (todo.dueAt !== null) {
        meta.push(
          h(
            'span',
            { key: 'due', className: overdue ? 'gt-chip-bad' : '', title: new Date(todo.dueAt).toLocaleString() },
            overdue
              ? t('meta.overdue', { n: daysLate(todo.dueAt, now) })
              : sameLocalDay(Date.parse(todo.dueAt), now)
                ? t('meta.today')
                : `${t('meta.due')} ${absoluteTime(Date.parse(todo.dueAt))}`,
          ),
        )
      }
      if (todo.tags.length > 0) {
        meta.push(h('span', { key: 'tags', className: 'gt-tag' }, todo.tags.map((tag) => `#${tag}`).join(' ')))
      }
      meta.push(h('span', { key: 'by' }, t(`meta.by.${todo.createdBy === 'agent' ? 'agent' : 'human'}`)))
      if (Array.isArray(todo.notes) && todo.notes.length > 0) {
        const latest = todo.notes[todo.notes.length - 1]
        meta.push(h('span', { key: 'notes', title: latest.text }, t('note.count', { n: todo.notes.length })))
      }
      if (todo.completion !== null && todo.completion !== undefined) {
        meta.push(h('span', { key: 'completed', title: todo.completion.summary }, t('meta.completed', { when: absoluteTime(todo.completion.at) })))
      }
      if (typeof todo.originDir === 'string' && todo.originDir !== '') {
        meta.push(h('span', { key: 'origin', title: todo.originDir }, t('meta.origin', { dir: shortPath(todo.originDir) })))
      }
      if (todo.sessionId !== '') {
        // A live conversation with no working directory cannot do the work. Say
        // so on the row instead of letting the next hand-off land there again.
        const stranded = todo.sessionAlive === true && (todo.sessionDir ?? '') === ''
        meta.push(
          h(
            'span',
            {
              key: 'session',
              className: stranded ? 'gt-chip-warn' : todo.sessionAlive === true ? 'gt-chip-ok' : '',
              title: stranded
                ? '这个会话没有工作目录，agent 在里面做不了事；用「派发：开新会话」重派一次'
                : (todo.sessionDir ?? ''),
            },
            stranded ? t('meta.session.noDir') : todo.sessionAlive === true ? t('meta.session.live') : t('meta.session.bound'),
          ),
        )
      }
      if (todo.lastDispatch !== null && todo.lastDispatch.ok !== true) {
        meta.push(h('span', { key: 'dispatchFail', className: 'gt-chip-bad', title: todo.lastDispatch.error ?? '' }, t('meta.dispatchFailed')))
      }

      const copy = (value) => {
        try {
          if (navigator?.clipboard?.writeText !== undefined) {
            navigator.clipboard.writeText(value)
            setCopied(value)
            setTimeout(() => setCopied(''), 1500)
          }
        } catch {
          /* clipboard is a nicety, never a failure */
        }
      }

      return h(
        'div',
        {
          className: 'gt-item',
          'data-status': todo.status,
          'data-overdue': overdue ? '1' : '0',
          'data-open': open ? '1' : '0',
          role: 'listitem',
        },
        h(
          'div',
          { className: 'gt-item-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'gt-check',
              'data-on': done ? '1' : '0',
              disabled: busy,
              title: done ? t('action.reopen') : t('action.done'),
              'aria-label': done ? t('action.reopen') : t('action.done'),
              onClick: () => onAction(done ? 'reopen' : 'done', todo),
            },
            h(Icon, { name: 'check', size: 12 }),
          ),
          h(
            'div',
            { className: 'gt-item-body' },
            h('div', { className: 'gt-item-title' }, todo.title),
            h(
              'div',
              { className: 'gt-meta' },
              meta.flatMap((node, index) =>
                index === 0 ? [node] : [h('span', { key: `sep${index}`, className: 'gt-meta-sep' }, '·'), node],
              ),
            ),
            // What is attached is half the point of the list, so the first few are
            // shown as chips instead of being reported as a number.
            todo.links.length > 0
              ? h(
                  'div',
                  { className: 'gt-attach' },
                  todo.links.slice(0, MAX_LINK_CHIPS).map((link, index) =>
                    link.kind === 'url'
                      ? h(
                          'a',
                          {
                            key: `${index}:${link.value}`,
                            className: 'gt-chip',
                            href: link.value,
                            target: '_blank',
                            rel: 'noreferrer noopener',
                            title: link.value,
                          },
                          h(Icon, { name: 'link', size: 11 }),
                          h('span', { className: 'gt-attach-title' }, link.title),
                        )
                      : h(
                          'button',
                          {
                            key: `${index}:${link.value}`,
                            type: 'button',
                            className: link.missing === true ? 'gt-chip gt-chip-bad' : 'gt-chip',
                            title:
                              link.missing === true
                                ? `${link.value} —— ${t('link.missing')}`
                                : `${link.value}（点击复制路径）`,
                            onClick: () => copy(link.value),
                          },
                          h(Icon, { name: 'doc', size: 11 }),
                          h('span', { className: 'gt-attach-title' }, copied === link.value ? t('action.copied') : link.title),
                        ),
                  ),
                  todo.links.length > MAX_LINK_CHIPS
                    ? h(
                        'button',
                        { type: 'button', className: 'gt-chip', onClick: () => onToggleOpen(todo.id) },
                        `+${todo.links.length - MAX_LINK_CHIPS}`,
                      )
                    : null,
                )
              : null,
            // What the work produced is the interesting part of a finished todo,
            // so the artifacts sit on the row next to the attachments.
            Array.isArray(todo.completion?.artifacts) && todo.completion.artifacts.length > 0
              ? h(
                  'div',
                  { className: 'gt-attach' },
                  todo.completion.artifacts.slice(0, MAX_LINK_CHIPS).map((link, index) =>
                    link.kind === 'url'
                      ? h(
                          'a',
                          {
                            key: `art:${index}:${link.value}`,
                            className: 'gt-chip gt-chip-ok',
                            href: link.value,
                            target: '_blank',
                            rel: 'noreferrer noopener',
                            title: link.value,
                          },
                          h(Icon, { name: 'check', size: 11 }),
                          h('span', { className: 'gt-attach-title' }, link.title),
                        )
                      : h(
                          'button',
                          {
                            key: `art:${index}:${link.value}`,
                            type: 'button',
                            className: 'gt-chip gt-chip-ok',
                            title: `${link.value}（点击复制路径）`,
                            onClick: () => copy(link.value),
                          },
                          h(Icon, { name: 'check', size: 11 }),
                          h('span', { className: 'gt-attach-title' }, copied === link.value ? t('action.copied') : link.title),
                        ),
                  ),
                  todo.completion.artifacts.length > MAX_LINK_CHIPS
                    ? h(
                        'button',
                        { type: 'button', className: 'gt-chip gt-chip-ok', onClick: () => onToggleOpen(todo.id) },
                        `+${todo.completion.artifacts.length - MAX_LINK_CHIPS}`,
                      )
                    : null,
                )
              : null,
          ),
          h(
            'div',
            { className: 'gt-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'gt-btn gt-btn-brand',
                disabled: busy,
                title: dispatchLabel,
                onClick: () => onAction('dispatch', todo),
              },
              h(Icon, { name: 'play', size: 12 }),
              dispatchLabel,
            ),
            h(Menu, {
              label: t('action.menu'),
              items: [
                {
                  key: 'toggle',
                  label: open ? t('action.hide') : t('action.detail'),
                  icon: 'chevron',
                  onSelect: () => onToggleOpen(todo.id),
                },
                done
                  ? { key: 'reopen', label: t('action.reopen'), icon: 'check', onSelect: () => onAction('reopen', todo) }
                  : { key: 'doing', label: t('action.doing'), icon: 'clock', onSelect: () => onAction('doing', todo) },
                {
                  key: 'remove',
                  label: confirming ? t('action.removeConfirm') : t('action.remove'),
                  icon: 'trash',
                  danger: true,
                  onSelect: () => {
                    if (!confirming) {
                      setConfirming(true)
                      setTimeout(() => setConfirming(false), 4000)
                      return
                    }
                    onAction('remove', todo)
                  },
                },
              ],
            }),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'gt-detail' },
              h(
                'div',
                { className: 'gt-section' },
                h('div', { className: 'gt-section-title' }, t('detail.edit')),
                h(
                  'div',
                  { className: 'gt-row' },
                  h('input', { className: 'gt-input', value: draft.title, 'aria-label': t('field.title'), onChange: (event) => setDraft({ ...draft, title: event.target.value }) }),
                  h(Segmented, {
                    label: t('field.priority'),
                    value: draft.priority,
                    onChange: (priority) => setDraft({ ...draft, priority }),
                    options: [
                      { value: 'low', label: t('priority.low') },
                      { value: 'normal', label: t('priority.normal') },
                      { value: 'high', label: t('priority.high') },
                      { value: 'urgent', label: t('priority.urgent') },
                    ],
                  }),
                  h('input', {
                    className: 'gt-input gt-input-sm',
                    type: 'datetime-local',
                    value: draft.due,
                    'aria-label': t('field.due'),
                    onChange: (event) => setDraft({ ...draft, due: event.target.value }),
                  }),
                ),
                h('textarea', {
                  className: 'gt-textarea',
                  value: draft.description,
                  placeholder: t('field.description'),
                  'aria-label': t('detail.description'),
                  onChange: (event) => setDraft({ ...draft, description: event.target.value }),
                }),
                dirty
                  ? h(
                      'div',
                      { className: 'gt-row' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'gt-btn gt-btn-primary',
                          disabled: busy,
                          onClick: () =>
                            onAction('save', todo, {
                              title: draft.title,
                              description: draft.description,
                              priority: draft.priority,
                              dueAt: draft.due === '' ? null : new Date(draft.due).toISOString(),
                            }),
                        },
                        t('action.save'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'gt-btn gt-btn-quiet',
                          onClick: () =>
                            setDraft({
                              title: todo.title,
                              description: todo.description,
                              due: toLocalInput(todo.dueAt),
                              priority: todo.priority,
                            }),
                        },
                        t('action.cancel'),
                      ),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'gt-section' },
                h('div', { className: 'gt-section-title' }, t('detail.notes')),
                (todo.notes ?? []).length === 0
                  ? h('div', { className: 'gt-muted' }, t('note.none'))
                  : h(
                      'ul',
                      { className: 'gt-links' },
                      (todo.notes ?? []).map((entry, index) =>
                        h(
                          'li',
                          { className: 'gt-link', key: `note:${index}:${entry.at}` },
                          h(
                            'span',
                            { className: 'gt-link-main' },
                            h(Icon, { name: 'doc', size: 13 }),
                            h('span', { className: 'gt-muted' }, `${absoluteTime(entry.at)} · ${entry.by === 'agent' ? t('note.by.agent') : t('note.by.human')}`),
                            h('span', { className: 'gt-completion' }, entry.text),
                          ),
                        ),
                      ),
                    ),
                h('textarea', {
                  className: 'gt-textarea',
                  placeholder: t('note.placeholder'),
                  value: noteDraft,
                  'aria-label': t('detail.notes'),
                  onChange: (event) => setNoteDraft(event.target.value),
                }),
                h(
                  'div',
                  { className: 'gt-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-btn gt-btn-brand',
                      disabled: noteDraft.trim() === '',
                      onClick: () => {
                        const text = noteDraft.trim()
                        if (text === '') return
                        setNoteDraft('')
                        void onAction('note', todo, { text })
                      },
                    },
                    t('note.add'),
                  ),
                ),
              ),
              todo.completion === null || todo.completion === undefined
                ? null
                : h(
                    'div',
                    { className: 'gt-section' },
                    h('div', { className: 'gt-section-title' }, t('detail.completion')),
                    h(
                      'div',
                      { className: 'gt-muted' },
                      `${absoluteTime(todo.completion.at)} · ${
                        todo.completion.by === 'agent' ? t('completion.by.agent') : t('completion.by.human')
                      }${todo.completion.sessionId === '' ? '' : ` · ${todo.completion.sessionId}`}`,
                    ),
                    h(
                      'div',
                      { className: 'gt-completion' },
                      todo.completion.summary === '' ? t('completion.none') : todo.completion.summary,
                    ),
                    todo.completion.artifacts.length === 0
                      ? null
                      : h(
                          'ul',
                          { className: 'gt-links' },
                          todo.completion.artifacts.map((link, index) =>
                            h(
                              'li',
                              { className: 'gt-link', key: `art:${index}:${link.value}` },
                              h(
                                'span',
                                { className: 'gt-link-main' },
                                h(Icon, { name: 'check', size: 13 }),
                                link.kind === 'url'
                                  ? h('a', { className: 'gt-link-title', href: link.value, target: '_blank', rel: 'noreferrer noopener' }, link.title)
                                  : h('span', { className: 'gt-link-title' }, link.title),
                                h('span', { className: 'gt-mono', title: link.value }, link.value),
                                link.missing === true
                                  ? h('span', { className: 'gt-chip-bad' }, t('link.missing'))
                                  : null,
                              ),
                              link.kind === 'url'
                                ? h('a', { className: 'gt-btn gt-btn-quiet', href: link.value, target: '_blank', rel: 'noreferrer noopener' }, t('action.open'))
                                : h(
                                    'button',
                                    { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => copy(link.value) },
                                    copied === link.value ? t('action.copied') : t('action.copy'),
                                  ),
                            ),
                          ),
                        ),
                  ),
              h(
                'div',
                { className: 'gt-section' },
                h('div', { className: 'gt-section-title' }, t('detail.links')),
                todo.links.length === 0
                  ? h('div', { className: 'gt-muted' }, t('detail.noLinks'))
                  : h(
                      'ul',
                      { className: 'gt-links' },
                      todo.links.map((link, index) =>
                        h(
                          'li',
                          { className: 'gt-link', key: `${link.kind}:${link.value}` },
                          h(
                            'span',
                            { className: 'gt-link-main' },
                            h(Icon, { name: link.kind === 'url' ? 'link' : 'doc', size: 13 }),
                            link.kind === 'url'
                              ? h('a', { className: 'gt-link-title', href: link.value, target: '_blank', rel: 'noreferrer noopener' }, link.title)
                              : h('span', { className: 'gt-link-title' }, link.title),
                            h('span', { className: 'gt-mono', title: link.value }, link.value),
                          ),
                          link.kind === 'url'
                            ? h('a', { className: 'gt-btn gt-btn-quiet', href: link.value, target: '_blank', rel: 'noreferrer noopener' }, t('action.open'))
                            : h(
                                'button',
                                { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => copy(link.value) },
                                copied === link.value ? t('action.copied') : t('action.copy'),
                              ),
                          h(
                            'button',
                            { type: 'button', className: 'gt-btn gt-btn-quiet', disabled: busy, onClick: () => onAction('unlink', todo, { index }) },
                            t('action.unlink'),
                          ),
                        ),
                      ),
                    ),
                h(
                  'div',
                  { className: 'gt-row' },
                  h('input', {
                    className: 'gt-input',
                    placeholder: t('field.linkValue'),
                    value: linkValue,
                    onChange: (event) => setLinkValue(event.target.value),
                  }),
                  h('input', {
                    className: 'gt-input gt-input-sm',
                    placeholder: t('field.linkTitle'),
                    value: linkTitle,
                    onChange: (event) => setLinkTitle(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-btn',
                      disabled: busy || linkValue.trim() === '',
                      onClick: () => {
                        onAction('link', todo, { add: [{ value: linkValue, ...(linkTitle.trim() === '' ? {} : { title: linkTitle }) }] })
                        setLinkValue('')
                        setLinkTitle('')
                      },
                    },
                    h(Icon, { name: 'plus', size: 12 }),
                    t('action.addLink'),
                  ),
                ),
              ),
              todo.lastDispatch !== null
                ? h(
                    'div',
                    { className: 'gt-section' },
                    h('div', { className: 'gt-section-title' }, t('detail.lastDispatch')),
                    h(
                      'div',
                      { className: 'gt-mono' },
                      `${new Date(todo.lastDispatch.at).toLocaleString()} · ${todo.lastDispatch.mode} · ${
                        todo.lastDispatch.ok === true ? (todo.lastDispatch.sessionId ?? '') : (todo.lastDispatch.error ?? '')
                      }`,
                    ),
                  )
                : null,
              Array.isArray(todo.activity) && todo.activity.length > 0
                ? h(
                    'div',
                    { className: 'gt-section' },
                    h('div', { className: 'gt-section-title' }, t('detail.activity')),
                    h(
                      'div',
                      { className: 'gt-activity' },
                      todo.activity
                        .slice(-6)
                        .reverse()
                        .map((entry, index) =>
                          h(
                            'div',
                            { key: index },
                            `${absoluteTime(entry.at)} · ${entry.by === 'agent' ? 'Agent' : lang === 'zh' ? '我' : 'me'} · ${entry.kind}${
                              entry.summary === undefined ? '' : ` · ${entry.summary}`
                            }`,
                          ),
                        ),
                    ),
                  )
                : null,
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ 面板

    /** @param {{ ctx: object, lang: 'zh' | 'en' }} props */
    function Panel(props) {
      const { ctx, lang } = props
      const t = useCallback((key, params) => translate(lang, key, params), [lang])

      const [state, setState] = useState({ todos: [], counts: null, health: null })
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [filter, setFilter] = useState('active')
      const [query, setQuery] = useState('')
      const [groupMode, setGroupMode] = useState(() => readStoredGroupMode())
      // A notice may carry an action: after a hand-off the useful next step is
      // to go and look at the conversation the work is actually in.
      const [notice, setNotice] = useState(null)
      const [busyId, setBusyId] = useState('')
      const [expandedId, setExpandedId] = useState('')
      // Default to the conversation in front of the user: a hand-off should mean
      // "you, here", not "some session this plugin remembers".
      // '' means "let the Host decide"; anything else is a conversation the user
      // picked, sent as authoritative.
      const [pickedTarget, setPickedTarget] = useState(() => readStoredTarget())
      const [more, setMore] = useState(false)
      const [collapsed, setCollapsed] = useState({})
      const [undo, setUndo] = useState(null)
      const [draft, setDraft] = useState({ title: '', description: '', links: '', tags: '', priority: 'normal', due: '' })
      // Conversations come from the shell's own sessions service, declared in this
      // plugin's `inject` list the way the shipped panels do it
      // (`ui-subagent` / `agent-team`: ["sessions", "uiWorkspace", "slots", "locale"]).
      // Reading the snapshot during render is deliberate: no effect, no
      // subscription, no state — so nothing here can re-render in a loop, which a
      // previous attempt at this list did (and took the page with it).
      const sessionRows = (() => {
        try {
          return ctx?.sessions?.list?.getSnapshot?.() ?? null
        } catch {
          return null
        }
      })()

      /** Slot props remain a fallback for a host that hands the hook to this slot. */
      const selectSessions = typeof props.useSessions === 'function' ? props.useSessions : (read) => read({ byId: {} })
      const propRows = selectSessions((state) => {
        try {
          return state?.byId ?? {}
        } catch {
          return {}
        }
      })
      const rows = Object.keys(sessionRows?.byId ?? {}).length > 0 ? sessionRows.byId : propRows
      const findCurrent = () => {
        try {
          return Object.values(rows ?? {}).find((session) => (session?.retainedBy?.mainView ?? 0) > 0)
        } catch {
          return undefined
        }
      }
      const currentRow = findCurrent()
      const currentSessionId = typeof currentRow?.id === 'string' ? currentRow.id : ''
      const currentCwd = typeof currentRow?.cwd === 'string' ? currentRow.cwd : ''
      const currentSessionTitle = typeof currentRow?.title === 'string' ? currentRow.title : ''
      const [pickedDir, setPickedDir] = useState(() => readStoredDir())
      // Conversation titles name the groups, the picker and the receipt.
      const sessionTitles = (() => {
        const map = {}
        for (const [id, row] of Object.entries(rows ?? {})) {
          if (typeof row?.title === 'string' && row.title !== '') map[id] = row.title
        }
        return map
      })()
      const effectiveDir = pickedDir !== '' ? pickedDir : currentCwd
      // `/health` reports the conversation the Host would pick on its own.
      const hostTargetId = state.health?.target?.recentSessionId ?? ''
      const hostTargetTitle = hostTargetId === '' ? '' : (sessionTitles[hostTargetId] ?? '')
      // What the picker shows, and therefore what the click will do: an explicit
      // choice wins, otherwise the Host's grounded answer, otherwise what this
      // panel can see. No hidden inference beyond that.
      const targetValue =
        pickedTarget !== '' ? pickedTarget : hostTargetId !== '' ? hostTargetId : currentSessionId !== '' ? currentSessionId : 'auto'
      const workspaceSnapshot = (() => {
        try {
          return ctx?.workspaces?.list?.getSnapshot?.() ?? null
        } catch {
          return null
        }
      })()
      // Workspaces name where a *new* conversation will live. The Host inherits
      // the workspace of the conversation that wrote the todo by default; listing
      // them here is the "or pick one yourself" half.
      const workspaceRows = workspaceSnapshot?.items ?? []
      const archivedIds = new Set(workspaceSnapshot?.archivedSessionIds ?? [])
      const isArchived = (row) => row?.archived === true || archivedIds.has(row?.id)
      // Which conversations the picker offers, in which order.
      //
      // `updatedAt` is the same recency key the sidebar sorts by, so "the one I used
      // last" is first and stale ones sink. Archived conversations are left out
      // entirely: an archived conversation is not an answer to "where should this
      // work go" — offering it would invite handing work into something the user
      // deliberately put away.
      const listedConversations = Object.values(rows ?? {})
        .filter(
          (row) =>
            typeof row?.id === 'string'
            && row.id !== ''
            && typeof row.title === 'string'
            && row.title !== ''
            && !isArchived(row),
        )
        .sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0) || (left.id < right.id ? 1 : -1))
        .map((row) => ({ id: row.id, title: row.title }))
      // Two conversations can share a title; a label that cannot be told apart is a
      // wrong hand-off waiting to happen, so duplicates get a short id suffix.
      const titleCounts = new Map()
      for (const entry of listedConversations) titleCounts.set(entry.title, (titleCounts.get(entry.title) ?? 0) + 1)
      const labelled = listedConversations.map((entry) => ({
        id: entry.id,
        title: titleCounts.get(entry.title) > 1 ? `${entry.title} · ${entry.id.slice(-4)}` : entry.title,
      }))
      const listedIds = new Set(labelled.map((entry) => entry.id))
      // The picker is a controlled select: if what it currently points at is not in
      // the list (archived since it was chosen, or not readable), show it anyway and
      // say so, rather than silently displaying a different conversation as selected.
      const pinnedEntry =
        targetValue !== '' && targetValue !== 'auto' && targetValue !== 'new' && !targetValue.startsWith('new:') && !listedIds.has(targetValue)
          ? [{ id: targetValue, title: `${sessionTitles[targetValue] ?? targetValue}（${t('target.archived')}）` }]
          : []
      const conversations = [...pinnedEntry, ...labelled]
      const mounted = useRef(true)
      const titleRef = useRef(null)
      const searchRef = useRef(null)
      const undoTimer = useRef(null)

      const reload = useCallback(
        async (next = {}) => {
          const status = next.filter ?? filter
          const search = next.query ?? query
          try {
            const data = await call('list', { query: { status, ...(search.trim() === '' ? {} : { query: search.trim() }) } })
            if (!mounted.current) return
            setState((current) => ({ ...current, todos: data.todos, counts: data.counts }))
            setError(null)
          } catch (failure) {
            if (!mounted.current) return
            setError(failure)
          } finally {
            if (mounted.current) setLoading(false)
          }
        },
        [filter, query],
      )

      useEffect(() => {
        mounted.current = true
        void reload()
        call('health')
          .then((data) => {
            if (mounted.current) setState((current) => ({ ...current, health: data }))
          })
          .catch(() => undefined)
        return () => {
          mounted.current = false
          if (undoTimer.current !== null) clearTimeout(undoTimer.current)
        }
        // Mount-only: later reloads go through the poll and the toolbar.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void reload()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [reload])

      // Keyboard: `/` search, `n` new, Escape collapse — but never while the
      // user is typing in a field.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => {
          const target = event.target
          const typing =
            target !== null &&
            target !== undefined &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)
          if (event.key === 'Escape') {
            setExpandedId('')
            if (typing && typeof target.blur === 'function') target.blur()
            return
          }
          if (typing || event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key === '/') {
            event.preventDefault()
            searchRef.current?.focus?.()
          } else if (event.key === 'n') {
            event.preventDefault()
            titleRef.current?.focus?.()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      const run = async (id, operation) => {
        setBusyId(id)
        try {
          await operation()
          await reload()
          setError(null)
        } catch (failure) {
          setError(failure)
        } finally {
          setBusyId('')
        }
      }

      const submit = async () => {
        const title = draft.title.trim()
        if (title === '') return
        const links = draft.links
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
        const tags = draft.tags
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
        await run('__new__', () =>
          call('create', {
            method: 'POST',
            body: {
              title,
              ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
              ...(links.length === 0 ? {} : { links }),
              ...(tags.length === 0 ? {} : { tags }),
              ...(draft.priority === 'normal' ? {} : { priority: draft.priority }),
              ...(draft.due === '' ? {} : { dueAt: new Date(draft.due).toISOString() }),
            },
          }),
        )
        setDraft({ title: '', description: '', links: '', tags: '', priority: 'normal', due: '' })
        setMore(false)
      }

      const autoCollectOn = state.health?.settings?.autoCollect === true
      const autoCollectCooldown = Number(state.health?.settings?.cooldownMinutes) || 30

      /** The switch is Host state: flipping it here writes through `/settings`. */
      const toggleAutoCollect = async (next) => {
        try {
          await call('settings', { method: 'POST', body: { autoCollect: next } })
          setError(null)
          setNotice({
            text: next ? t('notice.autoCollectOn', { n: autoCollectCooldown }) : t('notice.autoCollectOff'),
            sessionId: '',
          })
          setTimeout(() => setNotice(null), 6000)
          void refresh()
        } catch (failure) {
          setError(failure)
        }
      }

      /**
       * Ask one conversation to collect todos from itself.
       *
       * Takes the conversation as an argument because the action now lives on each
       * conversation's group: "the current one" is only unambiguous next to the
       * conversation it means, and a group already knows which one that is.
       */
      const requestCapture = async (sessionId = currentSessionId, title = currentSessionTitle) => {
        try {
          const result = await call('capture', {
            method: 'POST',
            body:
              sessionId === ''
                ? {}
                : {
                    sessionId,
                    // An explicit pick: the Host must ask *that* conversation, and
                    // wake it up if it is not running.
                    authoritative: true,
                  },
          })
          setError(null)
          setNotice({
            text:
              title === ''
                ? t('notice.capturedAnonymous')
                : t('notice.captured', { title }),
            sessionId: '',
          })
          setTimeout(() => setNotice(null), 8000)
          void refresh()
          void result
        } catch (failure) {
          setError(failure)
        }
      }

      const chooseDir = async () => {
        const pick = ctx?.get?.('uiWorkspace')?.pickDirectory
        if (typeof pick !== 'function') {
          setError(new ApiError('unsupported', '这个宿主没有目录选择器，请手动填工作目录'))
          return
        }
        try {
          const chosen = await pick()
          if (typeof chosen === 'string' && chosen !== '') {
            setPickedDir(chosen)
            storeStoredDir(chosen)
          }
        } catch (failure) {
          setError(failure)
        }
      }

      const followSession = () => {
        setPickedDir('')
        storeStoredDir('')
      }

      const showUndo = (todo) => {
        setUndo(todo)
        if (undoTimer.current !== null) clearTimeout(undoTimer.current)
        undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
      }

      const onAction = (kind, todo, payload) => {
        if (kind === 'done') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'done' } }))
        if (kind === 'reopen') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'open' } }))
        if (kind === 'doing') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'doing' } }))
        if (kind === 'save') return run(todo.id, () => call('update', { method: 'POST', body: { id: todo.id, ...payload } }))
        if (kind === 'note') return run(todo.id, () => call('note', { method: 'POST', body: { id: todo.id, ...payload } }))
        if (kind === 'link') return run(todo.id, () => call('link', { method: 'POST', body: { id: todo.id, ...payload } }))
        if (kind === 'unlink') return run(todo.id, () => call('link', { method: 'POST', body: { id: todo.id, remove: [payload.index] } }))
        if (kind === 'remove') {
          return run(todo.id, async () => {
            const removed = await call('remove', { method: 'POST', body: { id: todo.id } })
            showUndo(removed.todo ?? todo)
          })
        }
        if (kind === 'dispatch') {
          const inWorkspace = targetValue.startsWith('new:') ? targetValue.slice(4) : ''
          const pinned = targetValue === 'auto' || targetValue.startsWith('new') ? '' : targetValue
          const mode = targetValue.startsWith('new') ? 'new' : targetValue === 'auto' ? 'auto' : 'current'
          const sessionId = pinned
          return run(todo.id, async () => {
            const result = await call('dispatch', {
              method: 'POST',
              body: {
                id: todo.id,
                mode,
                ...(sessionId === '' ? {} : { sessionId, authoritative: true }),
                ...(effectiveDir === '' ? {} : { dir: effectiveDir }),
                ...(inWorkspace === '' ? {} : { workspaceId: inWorkspace }),
              },
            })
            // Say where it went. A hand-off that starts work in a conversation the
            // user is not looking at reads as "nothing happened" — which is exactly
            // how this was reported once.
            const target = typeof result?.sessionId === 'string' && result.sessionId !== '' ? result.sessionId : ''
            const title = target === '' ? '' : (sessionTitles[target] ?? '')
            setNotice({
              text:
                title !== ''
                  ? t('notice.dispatched', { title })
                  : t('notice.dispatchedAnonymous', { id: target === '' ? '?' : `…${target.slice(-8)}` }),
              sessionId: target,
            })
            setTimeout(() => setNotice(null), 20000)
            return result
          })
        }
        return undefined
      }

      const counts = state.counts ?? { total: 0, open: 0, doing: 0, done: 0, cancelled: 0, overdue: 0 }
      const groups = useMemo(
        () => groupTodos(state.todos, Date.now(), groupMode, sessionTitles, t),
        [state.todos, groupMode, sessionTitles, lang],
      )
      // The capture action lives on a conversation's group, so the toolbar keeps its
      // own version only for a conversation that has no group to carry it yet.
      const currentSessionHasGroup =
        currentSessionId !== ''
        && groups.some((group) => group.sessionId !== undefined && group.sessionId === currentSessionId)
      const dispatchLabel =
        targetValue === 'new'
          ? t('action.dispatchNew')
          : targetValue === 'auto'
            ? t('action.dispatchAuto')
            : t('action.dispatch')

      const filterChip = (key) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'gt-chip',
            'data-on': filter === key ? '1' : '0',
            'aria-pressed': filter === key,
            onClick: () => {
              setFilter(key)
              void reload({ filter: key })
            },
          },
          t(`filter.${key}`),
        )

      return h(
        'div',
        { className: 'gt-root' },
        h(
          'div',
          { className: 'gt-inner' },
          h(
            'div',
            { className: 'gt-head' },
            h(
              'div',
              { className: 'gt-headline' },
              h('div', { className: 'gt-title' }, t('panel.title')),
              h('div', { className: 'gt-sub' }, t('panel.subtitle')),
            ),
            h('div', { className: 'gt-spacer' }),
            h(
              'div',
              { className: 'gt-chips' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'gt-chip',
                  'data-on': filter === 'active' ? '1' : '0',
                  onClick: () => {
                    setFilter('active')
                    void reload({ filter: 'active' })
                  },
                },
                t('counts.active', { n: counts.open + counts.doing }),
              ),
              counts.overdue > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-chip gt-chip-bad',
                      'data-on': filter === 'overdue' ? '1' : '0',
                      onClick: () => {
                        setFilter('overdue')
                        void reload({ filter: 'overdue' })
                      },
                    },
                    t('counts.overdue', { n: counts.overdue }),
                  )
                : null,
              counts.done > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-chip gt-chip-ok',
                      'data-on': filter === 'done' ? '1' : '0',
                      onClick: () => {
                        setFilter('done')
                        void reload({ filter: 'done' })
                      },
                    },
                    t('counts.done', { n: counts.done }),
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'gt-chip',
                'data-on': autoCollectOn ? '1' : '0',
                'aria-pressed': autoCollectOn,
                title: t('autoCollect.hint', { n: autoCollectCooldown }),
                onClick: () => void toggleAutoCollect(!autoCollectOn),
              },
              t('autoCollect.label'),
            ),
            h(
              'button',
              { type: 'button', className: 'gt-iconbtn', onClick: () => void reload(), disabled: loading, title: t('action.refresh'), 'aria-label': t('action.refresh') },
              h(Icon, { name: 'refresh' }),
            ),
          ),
          // The capture action belongs to a conversation, so it lives on that
          // conversation's group. This fallback only appears when the conversation in
          // front of the user has no group yet — otherwise there would be no way to
          // collect from it at all.
          currentSessionHasGroup
            ? null
            : h(
                'div',
                { className: 'gt-row', style: { marginTop: '2px' } },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-btn gt-btn-brand',
                    title: t('action.captureHint'),
                    onClick: () => void requestCapture(),
                  },
                  h(Icon, { name: 'doc', size: 12 }),
                  t('action.capture'),
                ),
              ),

          error !== null
            ? h(
                'div',
                { className: 'gt-banner', role: 'alert' },
                `${t('error.prefix')}：${error.message}（${error.reason ?? 'internal'}）`,
                h('button', { type: 'button', className: 'gt-btn', onClick: () => void reload() }, t('action.retry')),
              )
            : null,

          h(
            'div',
            { className: 'gt-card gt-new' },
            h(
              'div',
              { className: 'gt-row' },
              h('input', {
                ref: titleRef,
                className: 'gt-input',
                placeholder: t('field.title'),
                value: draft.title,
                'aria-label': t('field.title'),
                onChange: (event) => setDraft({ ...draft, title: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void submit()
                },
              }),
              h(
                'button',
                { type: 'button', className: 'gt-btn gt-btn-primary', disabled: busyId === '__new__' || draft.title.trim() === '', onClick: () => void submit() },
                h(Icon, { name: 'plus', size: 13 }),
                t('action.add'),
              ),
              h(
                'button',
                { type: 'button', className: 'gt-btn gt-btn-quiet', 'aria-expanded': more, onClick: () => setMore((value) => !value) },
                more ? t('action.less') : t('action.more'),
              ),
            ),
            more
              ? h(
                  'div',
                  { className: 'gt-new' },
                  h('textarea', {
                    className: 'gt-textarea',
                    placeholder: t('field.description'),
                    value: draft.description,
                    'aria-label': t('detail.description'),
                    onChange: (event) => setDraft({ ...draft, description: event.target.value }),
                  }),
                  h('textarea', {
                    className: 'gt-textarea',
                    placeholder: t('field.links'),
                    value: draft.links,
                    'aria-label': t('detail.links'),
                    onChange: (event) => setDraft({ ...draft, links: event.target.value }),
                  }),
                  h(
                    'div',
                    { className: 'gt-row' },
                    h('input', {
                      className: 'gt-input gt-input-sm',
                      placeholder: t('field.tags'),
                      value: draft.tags,
                      'aria-label': t('field.tags'),
                      onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
                    }),
                    h(Segmented, {
                      label: t('field.priority'),
                      value: draft.priority,
                      onChange: (priority) => setDraft({ ...draft, priority }),
                      options: [
                        { value: 'urgent', label: t('priority.urgent') },
                        { value: 'high', label: t('priority.high') },
                        { value: 'normal', label: t('priority.normal') },
                        { value: 'low', label: t('priority.low') },
                      ],
                    }),
                    h('input', {
                      className: 'gt-input gt-input-sm',
                      type: 'datetime-local',
                      value: draft.due,
                      title: t('field.due'),
                      'aria-label': t('field.due'),
                      onChange: (event) => setDraft({ ...draft, due: event.target.value }),
                    }),
                  ),
                )
              : null,
          ),

          h(
            'div',
            { className: 'gt-toolbar' },
            h(
              'div',
              { className: 'gt-seg', role: 'group', 'aria-label': t('field.search') },
              ['all', 'active', 'doing', 'done', 'overdue'].map(filterChip),
            ),
            h(
              'label',
              { className: 'gt-search' },
              h(Icon, { name: 'search', size: 13 }),
              h('input', {
                ref: searchRef,
                placeholder: t('field.search'),
                title: t('search.hint'),
                value: query,
                'aria-label': t('field.search'),
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void reload({ query: event.target.value })
                },
                onBlur: (event) => void reload({ query: event.target.value }),
              }),
              h('span', { className: 'gt-kbd' }, '/'),
            ),
            h('div', { className: 'gt-spacer' }),
            h(
              'span',
              { className: 'gt-seg', role: 'group', 'aria-label': t('group.by'), title: t('group.by') },
              GROUP_MODES.map((mode) =>
                h(
                  'button',
                  {
                    key: mode,
                    type: 'button',
                    'data-on': groupMode === mode ? '1' : '0',
                    onClick: () => {
                      setGroupMode(mode)
                      storeStoredGroupMode(mode)
                    },
                  },
                  t(`group.${mode}`),
                ),
              ),
            ),
            h(
              'span',
              { className: 'gt-dir', title: effectiveDir === '' ? t('dir.none') : effectiveDir },
              h(Icon, { name: 'doc', size: 12 }),
              h('span', { className: 'gt-muted' }, `${t('field.dir')}：`),
              h('span', { className: 'gt-dir-path' }, effectiveDir === '' ? t('dir.none') : effectiveDir),
              h('span', { className: 'gt-muted' }, pickedDir === '' ? t('dir.fromSession') : t('dir.picked')),
              h('button', { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => void chooseDir() }, t('action.pickDir')),
              pickedDir === ''
                ? null
                : h('button', { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: followSession }, t('action.followSession')),
            ),
            h('span', { className: 'gt-muted' }, `${t('target.label')}：`),
            h(
              'select',
              {
                className: 'gt-select',
                value: targetValue,
                title: t('target.pick'),
                'aria-label': t('target.pick'),
                onChange: (event) => {
                  setPickedTarget(event.target.value)
                  storeStoredTarget(event.target.value)
                },
              },
              [
                // A conversation the user picks is sent as authoritative: no
                // inference on top of an explicit choice.
                ...(conversations.length === 0
                  ? [{ value: 'auto', label: t('target.none') }]
                  : conversations.map((entry) => ({
                  value: entry.id,
                      label: `${entry.title}${entry.id === hostTargetId ? ` ${t('target.recent')}` : ''}`,
                    }))),
                { value: 'new', label: t('target.newConversation') },
                ...workspaceRows.slice(0, 6).map((workspace) => ({
                  value: `new:${workspace.workspaceId}`,
                  label: t('target.newInWorkspace', { title: workspace.title ?? '' }),
                })),
                { value: 'auto', label: t('target.auto') },
              ].map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            ),
          ),

          loading && state.todos.length === 0
            ? h('div', { className: 'gt-empty' }, t('loading'))
            : state.todos.length === 0
              ? h(
                  'div',
                  { className: 'gt-empty' },
                  h('div', { className: 'gt-empty-title' }, filter === 'active' ? t('empty.none') : t('empty.filtered')),
                  h('div', { className: 'gt-sub' }, t('hint.keys')),
                )
              : h(
                  'div',
                  { className: 'gt-groups', role: 'list' },
                  groups.map((group) => {
                    const isCollapsed = collapsed[group.key] ?? group.collapsed === true
                    return h(
                      'div',
                      { className: 'gt-group', key: group.key, 'data-collapsed': isCollapsed ? '1' : '0' },
                      h(
                        'div',
                        { className: 'gt-group-head' },
                        h(
                          'button',
                          {
                            type: 'button',
                            'aria-expanded': !isCollapsed,
                            title: group.todos.map((todo) => todo.title).join('\n'),
                            onClick: () => setCollapsed({ ...collapsed, [group.key]: !isCollapsed }),
                          },
                          h(Icon, { name: 'chevron', size: 12 }),
                          h('span', { className: 'gt-group-label' }, group.label),
                          h('span', { className: 'gt-group-count' }, t('group.items', { n: group.todos.length })),
                          group.level === 'normal'
                            ? null
                            : h(
                                'span',
                                { className: 'gt-level', 'data-level': group.level },
                                t(`priority.${group.level}`),
                              ),
                          group.sessionId !== undefined && group.sessionId === currentSessionId
                            ? h('span', { className: 'gt-here' }, t('group.thisConversation'))
                            : null,
                          group.live
                            ? h('span', { className: 'gt-dot', title: t('meta.session.live'), 'aria-label': t('meta.session.live') })
                            : null,
                        ),
                        group.sessionId === undefined
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: 'gt-group-action',
                                title: t('action.captureGroupHint'),
                                onClick: (event) => {
                                  event.stopPropagation()
                                  void requestCapture(group.sessionId, group.label)
                                },
                              },
                              h(Icon, { name: 'doc', size: 11 }),
                              t('action.captureShort'),
                            ),
                      ),
                      isCollapsed
                        ? null
                        : h(
                            'div',
                            { className: 'gt-list' },
                            group.todos.map((todo) =>
                              h(TodoItem, {
                                key: todo.id,
                                todo,
                                lang,
                                busy: busyId === todo.id,
                                open: expandedId === todo.id,
                                dispatchLabel,
                                onAction,
                                onToggleOpen: (id) => setExpandedId((current) => (current === id ? '' : id)),
                              }),
                            ),
                          ),
                    )
                  }),
                ),

          h(
            'div',
            { className: 'gt-foot' },
            state.health !== null ? h('span', null, t('store.at', { file: state.health.store?.file ?? '' })) : null,
            state.health !== null
              ? h('span', { className: 'gt-mono' }, `v${state.health.version ?? ''}·${UI_REV}`)
              : null,
            h('span', null, t('hint.keys')),
          ),
        ),
        notice !== null && notice !== undefined
          ? h(
              'div',
              { className: 'gt-toast' },
              h('span', null, notice.text),
              // Only offer the jump when the capability is really there: a button
              // that does nothing is worse than no button.
              notice.sessionId === '' || typeof ctx?.uiWorkspace?.openSession !== 'function'
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-btn gt-btn-brand',
                      onClick: () => {
                        try {
                          // The shipped panels call it exactly like this
                          // (`ui-subagent`, `agent-team`): the service is a
                          // declared dependency, so it is on the plugin context.
                          ctx.uiWorkspace.openSession(notice.sessionId)
                        } catch (failure) {
                          setError(failure)
                        }
                      },
                    },
                    t('notice.openIt'),
                  ),
            )
          : null,
        undo !== null
          ? h(
              'div',
              { className: 'gt-toast', role: 'status' },
              h('span', null, t('deleted', { title: undo.title })),
              h(
                'button',
                {
                  type: 'button',
                  className: 'gt-btn',
                  onClick: () => {
                    const record = undo
                    setUndo(null)
                    if (undoTimer.current !== null) clearTimeout(undoTimer.current)
                    void run(record.id, () => call('restore', { method: 'POST', body: { todo: record } }))
                  },
                },
                t('action.undo'),
              ),
            )
          : null,
      )
    }

    /** @param {{ size?: number, active?: boolean }} props */
    function Glyph(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.6, y: 2.4, width: 12.8, height: 11.2, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M4.6 6.1l1.3 1.3 2.4-2.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M4.6 10.6h6.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /**
     * Install the stylesheet once, in a tag this plugin owns and removes on
     * unload. Idempotent: a second `apply` (or an HMR remount) reuses the tag.
     *
     * @returns {() => void}
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      // A hot reload replaces the module but **not** the DOM, so a stylesheet left
      // by a previous build must be replaced, never reused: the new markup uses
      // class names those old rules do not know, and the panel would render
      // unstyled while looking "unchanged" from the outside.
      const stale = document.querySelectorAll(`style[data-plugin-css="${SLOT_ID}"]`)
      for (const tag of stale) {
        if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
      }
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', SLOT_ID)
      tag.setAttribute('data-plugin-css-rev', UI_REV)
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
      }
    }

    /**
     * Re-render a slot occupant when the interface language changes.
     *
     * The service method must be invoked **on** the service: the locale
     * runtime's `subscribe` touches `this.listeners`, so extracting it into a
     * local variable loses `this` and throws inside the effect. A throw there is
     * worse than a missing translation — the shell retires a crashing panel
     * entry from its cell, which a user experiences as a permanently blank
     * panel — so the call is wrapped defensively as well.
     *
     * @param {object} ctx
     * @param {Function} Component
     * @returns {Function}
     */
    function withLocale(ctx, Component) {
      return function LocaleBound(props) {
        const [, bump] = useState(0)
        useEffect(() => {
          const locale = ctx.locale
          if (locale === null || locale === undefined || typeof locale.subscribe !== 'function') return undefined
          let previous = resolveLang(ctx)
          try {
            return locale.subscribe(() => {
              const next = resolveLang(ctx)
              if (next !== previous) {
                previous = next
                bump((value) => value + 1)
              }
            })
          } catch (error) {
            try {
              console.error('[dsh-global-todo] 语言订阅失败（面板仍可用）', error)
            } catch {
              /* logging must never throw */
            }
            return undefined
          }
        }, [])
        // The boundary sits between the locale wrapper and the panel, so a
        // panel crash is contained while the wrapper keeps translating.
        return h(PanelBoundary, { component: Component, componentProps: { ...props, ctx, lang: resolveLang(ctx) } })
      }
    }

    /**
     * Keep a crash inside this panel.
     *
     * The shell supervises slot entries: a component that throws while
     * rendering is *abdicated* — removed from its cell for the rest of that
     * registration's life, which a user experiences as a blank panel that never
     * comes back. Containing our own failures turns that into a visible message
     * with a retry button, and keeps the entry alive.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-global-todo] 面板渲染出错', error)
        } catch {
          /* logging must never throw */
        }
      }

      retry() {
        this.setState({ error: null })
      }

      render() {
        const { error } = this.state
        if (error !== null) {
          const message = error?.message ?? String(error)
          return h(
            'div',
            { className: 'gt-root' },
            h(
              'div',
              { className: 'gt-inner' },
              h(
                'div',
                { className: 'gt-banner', role: 'alert' },
                `全局待办面板出错了：${message}`,
                h('button', { type: 'button', className: 'gt-btn', onClick: this.retry }, '重试'),
              ),
            ),
          )
        }
        return h(this.props.component, this.props.componentProps)
      }
    }

    // ------------------------------------------------------------------ apply

    return {
      inject: ['sessions', 'uiWorkspace', 'workspaces', 'slots', 'locale'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), `${LOCALE_NS}: dictionaries`)
        ctx.effect(installStyles, `${LOCALE_NS}: styles`)

        // The sidebar entry id must equal the main panel key: that is how the
        // shell connects a click on the icon to the central panel.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: SLOT_ID,
              order: 86,
              label: () => (resolveLang(ctx) === 'zh' ? zh['entry.label'] : en['entry.label']),
              locale: LOCALE_NS,
            },
            Glyph,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: SLOT_ID, locale: LOCALE_NS }, withLocale(ctx, Panel)),
        )
      },
    }
  },
})
