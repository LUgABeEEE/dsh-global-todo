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
    const UI_REV = 'ui46'
    /** Last language resolved for the shell; module-level so a fetch failure can be worded too. */
    let activeLang = 'zh'

    // ------------------------------------------------------------------ 文案

    const zh = {
      'entry.label': '待办',
      'panel.title': '全局待办',
      'panel.subtitle': '跨会话一份清单，人和 Agent 都能加',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.add': '添加',
      'action.more': '更多字段',
      'action.overflow': '更多操作',
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
      'action.archive': '归档',
      'action.unarchive': '取消归档',
      'action.remove': '删除',
      'action.removeConfirm': '确认删除',
      'action.unlink': '摘掉',
      'action.addLink': '挂上',
      'action.open': '打开',
      'action.copy': '复制路径',
      'action.copyPathHint': '（点击复制路径）',
      'action.copied': '已复制',
      'action.undo': '撤销',
      'action.export': '导出',
      'action.import': '导入',
      'action.exportHint': '把整份清单导出成 JSON 文件（就是存储用的那份文档）',
      'action.importHint': '从 JSON 文件导入：同 id 覆盖、新 id 追加，不删除现有待办',
      'settings.title': '设置',
      'settings.context': '上下文',
      'settings.reminders': '到点提醒',
      'settings.remindersEnable': '开启到点提醒',
      'settings.lead': '提前（分钟）',
      'settings.ingest': '外部接入（ingest）',
      'settings.ingestEnable': '启用外部写入',
      'settings.token': '访问 token',
      'settings.tokenSet': '已设置，留空保持不变',
      'settings.generate': '轮换 token',
      'settings.confirmBelow': '置信度阈值',
      'settings.save': '保存',
      'settings.cancel': '取消',
      'settings.saved': '设置已保存',
      'settings.about': '关于',
      'action.keys': '快捷键',
      'review.confirm': '确认完成',
      'review.reject': '退回清单',
      'review.badge': '待确认',
      'review.hint': 'Agent 标记完成，等你确认；确认后才算真的完成。',
      'review.explain': '以下由 Agent 标记完成，确认后才算真的完成。',
      'filter.review': '待确认',
      'keys.search': '聚焦搜索',
      'keys.new': '开始记一条',
      'keys.save': '保存这条（在标题里）',
      'keys.close': '收起最内层浮层',
      'group.actions': '分组操作',
      'group.capture': '从本对话抓取',
      'group.exemptOn': '本工作区免打扰',
      'group.exemptOff': '取消本工作区免打扰',
      'settings.remindersHint': '到期时在面板顶部提示，并按设置提前。',
      'settings.ingestHint': '允许其他工具带 token 写入，先进收件箱。',
      'settings.tokenHint': '留空表示不改动；轮换后旧 token 立刻失效。',
      'settings.confirmBelowHint': '置信度低于这个值的条目进收件箱，不进清单。',
      'settings.storeFile': '数据文件',
      'settings.version': '版本',
      'inbox.explain': '以下由外部写入或 Agent 提交，确认后才进入清单。',
      'notice.exported': '已导出 {n} 条待办',
      'notice.imported': '已导入 {n} 条（合并，现有共 {total} 条）',
      'import.badJson': '这个文件不是合法的 JSON',
      'action.menu': '更多操作',
      'action.captureShort': '抓取',
      'summary.active': '{n} 未完成',
      'summary.overdue': '{n} 逾期',
      'summary.done': '{n} 已完成',
      'select.label': '选择',
      'select.on': '选择中',
      'select.count': '已选 {n} 条',
      'select.all': '全选',
      'select.allOn': '取消全选',
      'select.assign': '一键分配',
      'select.complete': '完成',
      'select.archive': '归档',
      'field.bulkTag': '标签…',
      'select.addTag': '加标签',
      'notice.bulk': '已更新 {n} 条',
      'notice.bulkPartial': '已更新 {n} 条，跳过 {m} 条',
      'select.clear': '清除',
      'select.done': '退出选择',
      'select.clearAll': '清空',
      'select.hint': '先勾几条待办，再点「一键分配」：优先回到写下它的那个对话，其次同工作区的对话，都找不到才让你选。',
      'assign.working': '正在分配…',
      'assign.summary': '已分配 {n} 条（原对话 {origin} · 同工作区 {workspace} · 你选的 {chosen}）',
      'assign.none': '这几条都没找到合适的对话，请选一个目标。',
      'assign.ask': '这 {n} 条找不到原对话，也没有同工作区的对话：选一个目标一起分配。',
      'assign.failed': '{n} 条没分出去：{detail}',
      'autoCollect.label': '自动获取',
      'autoCollect.idle': '安静窗口（分钟）',
      'autoCollect.hint': '开启后：某个对话**安静满 {n} 分钟**（期间没有任何新发言）才自动问它一次「有没有要跟进的事」；你一边说话它一边计时重置，所以工作时不会被打扰。它问过之后，**只有你在那个对话里再说一句话**才会重新问——不会追着自己的提问反复问。关掉就完全靠你和 Agent 手动记。',
      'autoCollect.last': '最近一次判定：{reason}（等待 {waiting} · 到点 {due}）',
      'autoCollect.reason.off': '开关关着',
      'autoCollect.reason.no-session': '没有会话',
      'autoCollect.reason.no-activity': '不知道安静了多久',
      'autoCollect.reason.exempt-workspace': '该工作区已豁免',
      'autoCollect.reason.unknown-dir': '不知道工作目录（保守不问）',
      'autoCollect.reason.retry-wait': '上次失败，等重试',
      'autoCollect.reason.awaiting-human': '问过，等你说话',
      'autoCollect.reason.not-idle-yet': '还没安静够',
      'autoCollect.reason.cooldown': '冷却中',
      'autoCollect.reason.ok': '可以问',
      'autoCollect.reason.turn': '轮次没有干净结束（{kind}）',
      'notice.autoCollectOn': '已开启自动获取：一次人为发言最多自动问一次',
      'notice.autoCollectOff': '已关闭自动获取',
      'notice.externalChange': '清单在别处被改过，已载入最新内容',
      'reminder.title': '到点提醒（{n}）',
      'reminder.note': '这些是到了设定的提醒时间，和「逾期」不是同一批。',
      'reminder.dismissAll': '全部知道了',
      'reminder.dismiss': '知道了',
      'reminder.enableNotifications': '开启系统通知',
      'reminder.notifyTitle': '待办到点',
      'import.preview': '将导入 {total} 条：新增 {create}、更新 {update}',
      'import.confirm': '导入',
      'meta.seqHint': '给人看的编号',
      'action.exempt': '豁免',
      'action.exemptOn': '已豁免',
      'action.exemptHint': '这个工作区里的对话永不自动获取（再点一下取消）',
      'action.exemptHintOn': '已豁免这个工作区：它下面的对话不会被自动问「有没有要跟进的事」。点一下取消豁免',
      'notice.exemptOn': '已豁免这个工作区：它下面的对话不会再被自动获取',
      'notice.exemptOff': '已取消豁免，这个工作区恢复自动获取',
      'action.captureGroupHint': '让这个对话里的 Agent 把该跟进的事登记成待办（结果归到这个对话下）',
      'notice.dispatched': '已交给「{title}」——去那个对话看它的进展',
      'notice.dispatchedAnonymous': '已交给当前对话（{id}）——去那个对话看它的进展',
      'notice.openIt': '打开那个对话',
      'notice.captured': '已让「{title}」抓取，稍等片刻清单会出现新条目',
      'notice.capturedAnonymous': '已让当前对话抓取，稍等片刻清单会出现新条目',
      'action.pickDir': '选择',
      'action.typeDir': '手动填',
      'action.useDir': '使用',
      'dir.manualHint': '粘一个绝对路径，回车即用',
      'dir.pickerMissing': '这次没能打开宿主的目录选择器（它的远程命名空间缺失或不可用），已改为内置浏览：点目录逐层进入，或用「手动填」。',
      'dir.browse': '浏览',
      'dir.up': '上一级',
      'dir.use': '用这个目录',
      'dir.close': '关闭',
      'dir.loading': '读取中…',
      'dir.empty': '（这里没有子目录）',
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
      'filter.archived': '已归档',
      'filter.inbox': '收件箱',
      'action.confirm': '确认',
      'action.discard': '丢弃',
      'meta.inbox': '待确认',
      'filter.label': '筛选',
      'field.title': '要做什么？回车即存',
      'field.description': '描述：验收标准、已知的坑…',
      'field.links': '相关文档与地址，一行一个（/绝对路径 或 https://…）',
      'field.tagsLabel': '标签',
      'field.titleLabel': '标题',
      'field.descriptionHint': '验收标准、已知的坑都可以写在这里。',
      'field.linksHint': '一行一个：绝对路径或 https:// 链接。',
      'field.tags': '标签，逗号分隔',
      'field.priority': '优先级',
      'field.due': '截止时间',
      'field.linkValue': '文档绝对路径或网址',
      'field.linkTitle': '给它起个短名字（可空）',
      'field.search': '搜标题、描述、标签、附件…',
      'priority.low': '低',
      'priority.normal': '常规',
      'priority.high': '高',
      'priority.urgent': '紧急',
      'group.by': '分组',
      'group.conversation': '对话',
      'group.time': '时间',
      'group.level': '级别',
      'group.manual': '手动添加',
      'group.other': '其他',
      'group.items': '{n} 条',
      'group.item': '1 条',
      'group.thisConversation': '本对话',
      'group.overdue': '逾期',
      'group.today': '今天',
      'group.soon': '接下来',
      'group.later': '以后',
      'group.none': '没有截止时间',
      'group.done': '已完成',
      'group.cancelled': '已取消',
      'empty.none': '还没有待办。上面写一句，回车就记下了。',
      'empty.add': '记第一条',
      'empty.filtered': '这个筛选下没有待办。',
      'empty.clearFilter': '清除筛选',
      'empty.filterHint': '换个筛选，或者清空搜索关键词。',
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
      'meta.session.noDirHint': '这个会话没有工作目录，agent 在里面做不了事；用「派发：开新会话」重派一次',
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
      'error.notJson': 'HTTP {status}：响应不是 JSON',
      'boundary.error': '全局待办面板出错了：{message}',
      'counts.active': '未完成 {n}',
      'counts.overdue': '逾期 {n}',
      'counts.done': '已完成 {n}',
      'store.at': '数据：{file}',
      'loading': '载入中…',
      'deleted': '已删除「{title}」',
      'hint.keys': '快捷键：/ 搜索 · n 新建 · Esc 收起',
      'list.truncated': '只显示前 {shown} 条，共 {matched} 条；用搜索或筛选缩小范围',
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
      'action.overflow': 'More actions',
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
      'action.archive': 'Archive',
      'action.unarchive': 'Unarchive',
      'action.remove': 'Delete',
      'action.removeConfirm': 'Confirm delete',
      'action.unlink': 'Remove',
      'action.addLink': 'Attach',
      'action.open': 'Open',
      'action.copy': 'Copy path',
      'action.copyPathHint': ' (click to copy path)',
      'action.copied': 'Copied',
      'action.undo': 'Undo',
      'action.export': 'Export',
      'action.import': 'Import',
      'action.exportHint': 'Download the whole list as JSON (the document the store keeps)',
      'action.importHint': 'Import a JSON file: same ids are updated, new ids appended, nothing deleted',
      'settings.title': 'Settings',
      'settings.context': 'Context',
      'settings.reminders': 'Due reminders',
      'settings.remindersEnable': 'Announce deadlines',
      'settings.lead': 'Lead time (min)',
      'settings.ingest': 'External ingest',
      'settings.ingestEnable': 'Accept external writes',
      'settings.token': 'Access token',
      'settings.tokenSet': 'Set — leave blank to keep',
      'settings.generate': 'Rotate token',
      'settings.confirmBelow': 'Confidence threshold',
      'settings.save': 'Save',
      'settings.cancel': 'Cancel',
      'settings.saved': 'Settings saved',
      'settings.about': 'About',
      'action.keys': 'Keyboard shortcuts',
      'review.confirm': 'Confirm done',
      'review.reject': 'Send back',
      'review.badge': 'Needs review',
      'review.hint': 'The agent says this is done; confirm it or send it back.',
      'review.explain': 'Finished by the agent. Confirm before it counts as done.',
      'filter.review': 'Review',
      'keys.search': 'Focus the search box',
      'keys.new': 'Start a new todo',
      'keys.save': 'Save it (from the title field)',
      'keys.close': 'Close the innermost layer',
      'group.actions': 'Group actions',
      'group.capture': 'Collect from this conversation',
      'group.exemptOn': 'Mute this workspace',
      'group.exemptOff': 'Unmute this workspace',
      'settings.remindersHint': 'Flag a deadline at the top of the panel when it comes due.',
      'settings.ingestHint': 'Let other tools POST todos with a token; they start in the inbox.',
      'settings.tokenHint': 'Leave blank to keep the current one; rotating invalidates the old token.',
      'settings.confirmBelowHint': 'Items below this confidence go to the inbox instead of the list.',
      'settings.storeFile': 'Data file',
      'settings.version': 'Version',
      'inbox.explain': 'Written by external sources or the agent. Confirm it before it joins the list.',
      'notice.exported': 'Exported {n} todos',
      'notice.imported': 'Imported {n} (merged; {total} in the list now)',
      'import.badJson': 'That file is not valid JSON',
      'action.menu': 'More actions',
      'action.captureShort': 'Collect',
      'summary.active': '{n} open',
      'summary.overdue': '{n} overdue',
      'summary.done': '{n} done',
      'select.label': 'Select',
      'select.on': 'Selecting',
      'select.count': '{n} selected',
      'select.all': 'Select all',
      'select.allOn': 'Clear selection',
      'select.assign': 'Assign',
      'select.complete': 'Complete',
      'select.archive': 'Archive',
      'field.bulkTag': 'Tag…',
      'select.addTag': 'Add tag',
      'notice.bulk': 'Updated {n}',
      'notice.bulkPartial': 'Updated {n}, skipped {m}',
      'select.clear': 'Clear',
      'select.done': 'Exit selection',
      'select.clearAll': 'Clear',
      'select.hint': 'Pick a few todos, then Assign: back to the conversation that wrote each one, else a conversation in the same workspace, else you choose.',
      'assign.working': 'Assigning…',
      'assign.summary': 'Assigned {n} ({origin} to origin · {workspace} same workspace · {chosen} chosen)',
      'assign.none': 'None of these had a conversation to go to — pick one.',
      'assign.ask': '{n} of them have no origin and no same-workspace conversation: pick one target for those.',
      'assign.failed': '{n} could not be assigned: {detail}',
      'autoCollect.label': 'Auto-collect',
      'autoCollect.idle': 'Idle window (minutes)',
      'autoCollect.hint': 'When on: a conversation is asked once whether anything needs following up, but only after it has been **quiet for {n} minutes** — every new message restarts that clock, so a session you are working in is never interrupted. Once it has asked, only **you writing in that conversation** arms it again, so the question can never chase its own answer.',
      'autoCollect.last': 'Last decision: {reason} (waiting {waiting}, due {due})',
      'autoCollect.reason.off': 'the switch is off',
      'autoCollect.reason.no-session': 'no conversation',
      'autoCollect.reason.no-activity': 'the quiet time is unknown',
      'autoCollect.reason.exempt-workspace': 'that workspace is exempt',
      'autoCollect.reason.unknown-dir': 'the working directory is unknown (stays quiet)',
      'autoCollect.reason.retry-wait': 'the last attempt failed; waiting to retry',
      'autoCollect.reason.awaiting-human': 'asked; waiting for you to speak',
      'autoCollect.reason.not-idle-yet': 'not quiet for long enough yet',
      'autoCollect.reason.cooldown': 'cooling down',
      'autoCollect.reason.ok': 'ready to ask',
      'autoCollect.reason.turn': 'the turn did not end cleanly ({kind})',
      'notice.autoCollectOn': 'Auto-collect on: at most one question per message from you',
      'notice.autoCollectOff': 'Auto-collect off',
      'notice.externalChange': 'The list changed somewhere else; the latest content is loaded',
      'reminder.title': 'Due now ({n})',
      'reminder.note': 'These reached their reminder time — a different set from Overdue.',
      'reminder.dismissAll': 'Dismiss all',
      'reminder.dismiss': 'Dismiss',
      'reminder.enableNotifications': 'Enable notifications',
      'reminder.notifyTitle': 'Todo due',
      'import.preview': 'Will import {total}: {create} new, {update} updated',
      'import.confirm': 'Import',
      'meta.seqHint': 'Human-facing number',
      'action.exempt': 'Exempt',
      'action.exemptOn': 'Exempted',
      'action.exemptHint': 'Never auto-collect in this workspace (click again to undo)',
      'action.exemptHintOn': 'This workspace is exempt: its conversations are never asked. Click to undo',
      'notice.exemptOn': 'Workspace exempted: its conversations will not be asked again',
      'notice.exemptOff': 'Exemption removed: this workspace is asked again',
      'action.captureGroupHint': 'Ask this conversation to record what needs following up (the items land under it)',
      'notice.dispatched': 'Handed to “{title}” — watch it there',
      'notice.dispatchedAnonymous': 'Handed to the current conversation ({id}) — watch it there',
      'notice.openIt': 'Open it',
      'notice.captured': 'Asked “{title}” to collect — new items will show up shortly',
      'notice.capturedAnonymous': 'Asked the current conversation to collect — new items will show up shortly',
      'action.pickDir': 'Choose',
      'action.typeDir': 'Type a path',
      'action.useDir': 'Use',
      'dir.manualHint': 'Paste an absolute path and press Enter',
      'dir.pickerMissing': "The Host's directory picker could not be opened this time (its remote namespace is missing or unavailable). The built-in browser is in use instead: open folders to walk down, or type the path.",
      'dir.browse': 'Browse',
      'dir.up': 'Up',
      'dir.use': 'Use this folder',
      'dir.close': 'Close',
      'dir.loading': 'Reading…',
      'dir.empty': '(no sub-folders here)',
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
      'meta.completed': 'Completed {when}',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'filter.all': 'All',
      'filter.active': 'Open',
      'filter.doing': 'Doing',
      'filter.done': 'Done',
      'filter.overdue': 'Overdue',
      'filter.archived': 'Archived',
      'filter.inbox': 'Inbox',
      'action.confirm': 'Confirm',
      'action.discard': 'Discard',
      'meta.inbox': 'Needs review',
      'filter.label': 'Filters',
      'field.title': 'What needs doing? Enter to save',
      'field.description': 'Description: acceptance, known traps…',
      'field.links': 'Documents and links, one per line (/abs/path or https://…)',
      'field.tagsLabel': 'Tags',
      'field.titleLabel': 'Title',
      'field.descriptionHint': 'Acceptance criteria and known traps belong here.',
      'field.linksHint': 'One per line: an absolute path or an https:// link.',
      'field.tags': 'Tags, comma separated',
      'field.priority': 'Priority',
      'field.due': 'Due',
      'field.linkValue': 'Absolute document path or URL',
      'field.linkTitle': 'Short label (optional)',
      'field.search': 'Search title, description, tags, attachments…',
      'priority.low': 'Low',
      'priority.normal': 'Normal',
      'priority.high': 'High',
      'priority.urgent': 'Urgent',
      'group.by': 'Group',
      'group.time': 'Time',
      'group.level': 'Level',
      'group.manual': 'Added by hand',
      'group.other': 'Other',
      'group.items': '{n} items',
      'group.item': '1 item',
      'group.thisConversation': 'this conversation',
      'group.overdue': 'Overdue',
      'group.today': 'Today',
      'group.soon': 'Next up',
      'group.later': 'Later',
      'group.none': 'No due date',
      'group.done': 'Done',
      'group.cancelled': 'Cancelled',
      'empty.none': 'No todos yet. Write one above and press Enter.',
      'empty.add': 'Add your first todo',
      'empty.filtered': 'Nothing matches this filter.',
      'empty.clearFilter': 'Clear filter',
      'empty.filterHint': 'Try another filter, or clear the search box.',
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
      'meta.session.noDirHint': 'This conversation has no working directory, so an agent cannot do anything in it; hand it off again with a new conversation.',
      'meta.dispatchFailed': 'last hand-off failed',
      'detail.description': 'Description',
      'detail.noDescription': 'No description.',
      'detail.links': 'Documents and links',
      'detail.noLinks': 'No attachments. Attach an absolute document path, or a URL.',
      'detail.activity': 'Activity',
      'detail.lastDispatch': 'Last hand-off',
      'detail.edit': 'Edit',
      'error.prefix': 'Error',
      'error.notJson': 'HTTP {status}: the response was not JSON',
      'boundary.error': 'The todo panel crashed: {message}',
      'counts.active': 'Open {n}',
      'counts.overdue': 'Overdue {n}',
      'counts.done': 'Done {n}',
      'store.at': 'Data: {file}',
      'loading': 'Loading…',
      'deleted': 'Deleted “{title}”',
      'hint.keys': 'Keys: / search · n new · Esc collapse',
      'list.truncated': 'Showing the first {shown} of {matched}; narrow the search or filter to see the rest',
      'justNow': 'just now',
      'minutesAgo': '{n} min ago',
      'hoursAgo': '{n} h ago',
      'daysAgo': '{n} d ago',
      'group.conversation': 'Conversation',
      'detail.completion': 'Completion',
      'detail.notes': 'Progress notes',
      'note.placeholder': 'Add a note: where this stands, what is blocking it, who needs to act',
      'note.add': 'Add note',
      'note.by.agent': 'Agent',
      'note.by.human': 'You',
      'note.none': 'No notes yet.',
      'note.count': '{n} notes',
      'note.latest': 'Latest: {text}',
      'link.missing': 'File is gone (moved or deleted)',
      'search.hint': 'Supports tag:release / is:overdue / has:link / level:p0, space-separated',
      'completion.by.agent': 'Finished by the agent',
      'completion.by.human': 'Finished by you',
      'completion.auto': 'Recorded automatically when the session finished',
      'completion.none': 'No closing summary',
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
        // LocaleSnapshot is { active, locales, revision }. The older guess looked for
        // locale/id/language/current, so switching the language in settings never reached
        // this panel; keep the fallbacks for a host that still answers another shape.
        const raw = snapshot?.active ?? snapshot?.locale ?? snapshot?.id ?? snapshot?.language ?? snapshot?.current ?? ''
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

    /**
     * Tell the Host what went wrong.
     *
     * The panel is the only place these failures are visible, and it lives in someone
     * else's browser; the Host is where they can actually be read afterwards. Rate
     * limited per distinct message, because the list polls every 20 seconds and a
     * broken route would otherwise file the same report forever.
     *
     * @param {string} scope
     * @param {{ status?: number, reason?: string, message?: string }} detail
     */
    const reported = new Map()
    function reportFailure(scope, detail = {}) {
      try {
        const key = `${scope}|${detail.status ?? ''}|${detail.reason ?? ''}|${detail.message ?? ''}`
        const at = Date.now()
        if (at - (reported.get(key) ?? 0) < 5000) return
        reported.set(key, at)
        if (reported.size > 40) reported.clear()
        void fetch(`${API}/diagnostics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope,
            status: detail.status ?? 0,
            reason: detail.reason ?? '',
            message: detail.message ?? '',
            url: typeof location === 'undefined' ? '' : location.href,
          }),
        }).catch(() => {})
      } catch {
        /* reporting must never break the panel it reports about */
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
        reportFailure('call', { status: response.status, reason: 'not-json', message: path })
        throw new ApiError('internal', translate(activeLang, 'error.notJson', { status: response.status }))
      }
      if (payload?.ok === true) return payload.data
      reportFailure('call', {
        status: response.status,
        reason: payload?.reason,
        message: `${path}: ${payload?.error ?? ''}`,
      })
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
      if (props.name === 'close') return h('svg', common, h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }))
      if (props.name === 'gear') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8' }),
          h('circle', { cx: 6, cy: 4.4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 10, cy: 8, r: 1.5, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 5.2, cy: 11.6, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        )
      }
      if (props.name === 'chevron') return h('svg', common, h('path', { d: 'M5.6 3.8L10 8l-4.4 4.2' }))
      if (props.name === 'flag') return h('svg', common, h('path', { d: 'M4 14V2.6h7l-1.2 2.8L11 8.2H4' }))
      if (props.name === 'mute') {
        return h(
          'svg',
          common,
          h('circle', { cx: 8, cy: 8, r: 5.6 }),
          h('path', { d: 'M4.2 11.8l7.6-7.6' }),
        )
      }
      return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.4 }))
    }

    // ------------------------------------------------------------------ 样式

    const CSS = `
.gt-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.gt-inner { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 1040px; min-width: 0;
  box-sizing: border-box; margin: 0 auto; padding: 20px 24px 32px; flex: 1; }
.gt-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.gt-head-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex: 0 0 auto; }
.gt-headline { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gt-title { font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: 0; }
.gt-sub { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.gt-spacer { flex: 1; }
.gt-iconbtn { display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  background: transparent; color: var(--dsw-alias-label-secondary); border: 1px solid transparent;
  border-radius: 8px; padding: 0 7px; min-height: 28px; min-width: 28px; box-sizing: border-box;
  font: inherit; cursor: pointer; }
.gt-iconbtn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.gt-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  padding: 0 11px; min-height: 28px; box-sizing: border-box; font: inherit; font-size: 13px;
  font-weight: 500; line-height: 20px; cursor: pointer; white-space: nowrap; }
.gt-btn:hover { border-color: var(--dsw-alias-border-l2); }
.gt-btn:disabled { opacity: 1; background: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
  border-color: transparent; cursor: default; }
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
.gt-new-fields { display: flex; flex-direction: column; gap: 12px; padding-top: 4px;
  border-top: 1px solid var(--dsw-alias-border-l1); }
.gt-new-fields .gt-textarea { min-height: 64px; }
.gt-new-fields .gt-field-row { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 12px; }
.gt-edit-meta { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 12px; align-items: start; }
/* The 340px card cannot hold the two-column meta row or a path beside two buttons:
   stack them there, and let attachments wrap onto their own lines. */
.gt-root[data-wide="1"][data-wide-detail="1"] .gt-detail .gt-edit-meta,
.gt-root[data-wide="1"][data-wide-detail="1"] .gt-detail .gt-new-fields .gt-field-row {
  grid-template-columns: minmax(0, 1fr); }
.gt-root[data-wide="1"][data-wide-detail="1"] .gt-detail .gt-link { flex-wrap: wrap; row-gap: 4px; }
.gt-root[data-wide="1"][data-wide-detail="1"] .gt-detail .gt-link .gt-mono { display: none; }
.gt-root[data-wide="1"][data-wide-detail="1"] .gt-detail .gt-link-main { flex: 1 1 100%; }
.gt-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gt-input, .gt-select, .gt-textarea { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 10px; font: inherit; }
.gt-input:focus, .gt-select:focus, .gt-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.gt-input { flex: 1; min-width: 120px; }
.gt-input-sm { flex: 0 1 auto; min-width: 96px; }
.gt-textarea { width: 100%; min-height: 54px; resize: vertical; font-family: inherit; }
.gt-select { padding: 6px 7px; }
.gt-search { display: flex; align-items: center; gap: 6px; flex: 1 1 220px; min-width: 0;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  min-height: 30px; box-sizing: border-box; padding: 0 9px; color: var(--dsw-alias-label-secondary); }
.gt-search input { flex: 1; background: transparent; border: none; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; padding: 0; min-width: 0; }
.gt-search input:focus { outline: none; }
.gt-search:focus-within { border-color: var(--dsw-alias-brand-primary); }
.gt-kbd { font-size: 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  padding: 0 4px; color: var(--dsw-alias-label-secondary); }
.gt-dir { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; padding: 3px 6px 3px 8px; max-width: 560px; }
/* Only the path may shrink. Everything else in the pill used to shrink with it, so a
   long working directory broke 「工作目录：」 mid-label as soon as the third button
   (浏览) joined the row — the path already ellipsises, so let it do the yielding. */
.gt-dir > .gt-muted, .gt-dir > .gt-btn, .gt-dir > svg { white-space: nowrap; flex-shrink: 0; }
.gt-dir-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.gt-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: 8px 10px; }
.gt-toolbar-main { grid-column: 1 / -1; grid-row: 1; display: flex; align-items: center;
  gap: 8px; min-width: 0; flex-wrap: nowrap; }
.gt-toolbar-main .gt-search { flex: 1 1 auto; }
.gt-toolbar > .gt-spacer { display: none; }
.gt-toolbar > .gt-context-summary { grid-row: 2; grid-column: 1; min-width: 0; }
.gt-toolbar > .gt-tabs { grid-row: 2; grid-column: 2; justify-self: end; }
.gt-toolbar > .gt-context-details { grid-column: 1 / -1; grid-row: 3; }
@media (max-width: 1250px) { .gt-toolbar-main { flex-wrap: wrap; } }
.gt-seg { display: inline-flex; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; padding: 2px; gap: 2px; }
.gt-seg button { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit;
  border-radius: 7px; padding: 3px 10px; cursor: pointer; }
.gt-seg button[data-on="1"] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); font-weight: 600; }
.gt-chips { display: flex; gap: 6px; flex-wrap: wrap; }
/* One segmented style for every control that is "pick one of these": filters, grouping,
   the two toggles. Chips stay for facts about a todo (tags, levels, notes). */
.gt-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.gt-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit;
  font-size: 12px; border-radius: 6px; padding: 0 10px; min-height: 24px; box-sizing: border-box;
  cursor: pointer; white-space: nowrap; }
.gt-tab:hover { color: var(--dsw-alias-label-primary); }
.gt-tab[data-on="1"] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); font-weight: 600; }
.gt-summary { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gt-browse { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; }
.gt-browse-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.gt-browse-list { display: flex; flex-wrap: wrap; gap: 4px; }
.gt-browse-item { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; border-radius: 6px; padding: 2px 8px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; }
.gt-browse-item:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.gt-divider { width: 1px; height: 16px; background: var(--dsw-alias-border-l1); }
.gt-context { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.gt-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 16px; padding: 2px 8px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-secondary); }
button.gt-chip { cursor: pointer; font-family: inherit; }
button.gt-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
button.gt-chip[data-on="1"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-1); }
.gt-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.gt-chip-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.gt-chip-ok { color: var(--dsw-alias-state-success-primary); }
.gt-groups { display: flex; flex-direction: column; gap: 18px; overflow: auto; min-height: 0; flex: 1; }
.gt-group { display: flex; flex-direction: column; gap: 6px; }
.gt-group-head { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 18px; padding: 0 2px; }
.gt-group-head button { border: none; background: transparent; color: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; font: inherit; padding: 2px 0; }
.gt-group-head svg { transition: transform .12s ease; transform: rotate(90deg); }
.gt-group[data-collapsed="1"] .gt-group-head svg { transform: rotate(0deg); }
.gt-group-flag { margin-left: 2px; display: inline-flex; align-items: center; color: var(--dsw-alias-label-secondary); }
/* The group kebab stays quiet until the row is hovered or focused. */
.gt-group-head .gt-iconbtn { margin-left: 2px; min-width: 24px; min-height: 24px; opacity: 0;
  transition: opacity .12s ease; }
.gt-group:hover .gt-group-head .gt-iconbtn, .gt-group-head .gt-iconbtn:focus-visible,
.gt-group-head .gt-iconbtn[aria-expanded="true"] { opacity: .72; }
.gt-group-head .gt-iconbtn:hover { opacity: 1; }
.gt-group-count { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; }
/* A group's level is redundant while it is expanded — the rows show it. */
.gt-group:not([data-collapsed="1"]) .gt-group-head .gt-level { display: none; }
.gt-group-label { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 12px;
  line-height: 18px; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-level { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; padding: 0;
  border: none; color: var(--dsw-alias-label-secondary); }
.gt-level[data-level="urgent"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.gt-level[data-level="high"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.gt-level[data-level="low"] { color: var(--dsw-alias-label-secondary); }
.gt-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-success-primary);
  display: inline-block; }
.gt-here { font-size: 11px; padding: 0 5px; border-radius: 999px; border: 1px solid var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary); }
.gt-list { display: flex; flex-direction: column; gap: 8px; }
.gt-item { position: relative; display: flex; flex-direction: column; gap: 8px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; padding: 12px 14px; min-height: 72px; box-sizing: border-box; }
.gt-item:hover { border-color: var(--dsw-alias-border-l2); }
.gt-item[data-status="doing"] { border-left: 2px solid var(--dsw-alias-brand-primary); }
.gt-item[data-overdue="1"] { border-left: 2px solid var(--dsw-alias-state-error-primary); }
.gt-item[data-status="done"], .gt-item[data-status="cancelled"] { opacity: .72; }
.gt-item[data-open="1"] { border-color: var(--dsw-alias-brand-primary); }
.gt-item-head { display: flex; gap: 10px; align-items: flex-start; }
.gt-check { flex: 0 0 auto; width: 24px; height: 24px; margin-top: 0; border-radius: 999px; cursor: pointer;
  border: 1.4px solid var(--dsw-alias-border-l2); background: transparent; color: transparent;
  display: inline-flex; align-items: center; justify-content: center; padding: 0; }
.gt-check:hover { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.gt-check[data-on="1"] { border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-bg-base); }
.gt-pick { flex: 0 0 auto; width: 22px; height: 22px; margin-top: 1px; border-radius: 6px; cursor: pointer;
  border: 1.4px solid var(--dsw-alias-border-l2); background: transparent; color: transparent;
  display: inline-flex; align-items: center; justify-content: center; padding: 0; }
.gt-pick[data-on="1"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.gt-item[data-selected="1"] { border-color: var(--dsw-alias-brand-primary); }
.gt-selectbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
  gap: 8px; flex-wrap: wrap; padding: 0 12px; min-height: 36px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); font-size: 13px; }
.gt-selectbar-count { font-weight: 600; white-space: nowrap; }
.gt-item-body { flex: 1; display: flex; flex-direction: column; gap: 5px; min-width: 0; cursor: pointer; }
.gt-item-body:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }
.gt-item-title { font-weight: 600; font-size: 14px; word-break: break-word; line-height: 22px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.gt-input-xs { width: 64px; flex: 0 0 auto; min-width: 0; padding: 0 8px; min-height: 28px;
  box-sizing: border-box; font-size: 12px; }
.gt-seq { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.gt-reminders { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px;
  min-height: 36px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; }
.gt-reminders { border-left: 2px solid var(--dsw-alias-state-warn-primary); }
.gt-reminders-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.gt-reminder-item { border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 2px 6px;
  border-radius: 6px; cursor: pointer; max-width: 300px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.gt-reminder-item:hover { background: var(--dsw-alias-button-ghost-active-fill); }
.gt-settings { display: flex; flex-direction: column; width: 360px; max-width: 100%;
  box-sizing: border-box; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px; background: var(--dsw-alias-bg-overlay); font-size: 13px; line-height: 20px; }
.gt-settings-head { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between;
  gap: 8px; padding: 10px 10px 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.gt-settings-title { font-size: 14px; font-weight: 600; }
.gt-settings-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 16px;
  padding: 14px 16px; overflow: auto; min-height: 0; }
.gt-settings-group { display: flex; flex-direction: column; gap: 8px; }
.gt-settings-group + .gt-settings-group { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 14px; }
.gt-settings-group-title { font-size: 12px; line-height: 18px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); }
.gt-check-row { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.gt-check-row input { margin: 3px 0 0; flex: 0 0 auto; }
.gt-check-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gt-check-label { color: var(--dsw-alias-label-primary); }
.gt-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.gt-field { display: flex; flex-direction: column; gap: 6px; }
.gt-field[data-muted="1"], .gt-field-row[data-muted="1"] { opacity: .55; }
.gt-field-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.gt-field-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.gt-field-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; }
.gt-input-num { width: 76px; text-align: right; font-variant-numeric: tabular-nums; }
.gt-link-btn { border: none; background: transparent; padding: 0; font: inherit; font-size: 12px;
  color: var(--dsw-alias-link); cursor: pointer; }
.gt-link-btn:disabled { color: var(--dsw-alias-label-secondary); cursor: default; }
.gt-about-row { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.gt-settings-foot { display: flex; flex: 0 0 auto; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.gt-keys { width: 320px; }
.gt-key-row { display: flex; align-items: center; gap: 10px; }
.gt-key-row .gt-kbd { min-width: 44px; text-align: center; }
.gt-group-select { display: none; min-height: 28px; max-width: 150px; padding: 0 8px; font: inherit;
  font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.gt-root[data-wide="0"] .gt-group-tabs { display: none; }
.gt-root[data-wide="0"] .gt-group-select { display: inline-flex; align-items: center; }
.gt-inbox-note { padding: 0 2px 2px; color: var(--dsw-alias-label-secondary); font-size: 13px;
  line-height: 20px; }
.gt-settings-path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-settings .gt-input { flex: 0 0 auto; width: 100%; min-height: 32px; }
.gt-settings .gt-input-num { width: 76px; }
.gt-check-line { display: flex; align-items: center; gap: 8px; justify-content: flex-start;
  color: var(--dsw-alias-label-primary); }
.gt-settings-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.gt-context-summary { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.gt-context-summary .gt-chip { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-context-details { display: none; flex-direction: column; gap: 8px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); }
.gt-context-details[data-open="1"] { display: flex; }
.gt-detail-head { display: flex; align-items: flex-start; gap: 8px; justify-content: space-between; }
/* Inline detail sits directly under its row: repeating the title would read as a second item. */
.gt-root[data-wide="0"][data-wide-detail="1"] .gt-detail-title { display: none; }
.gt-root[data-wide="0"][data-wide-detail="1"] .gt-detail-head { justify-content: flex-end; }
.gt-detail-title { font-size: 14px; line-height: 22px; font-weight: 600; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-truncated { color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.gt-bulk-tag { flex: 0 1 120px; min-width: 90px; }
.gt-review { padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600;
  color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.gt-inbox { margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600;
  color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary);
  vertical-align: 1px; }
.gt-item[data-status="done"] .gt-item-title, .gt-item[data-status="cancelled"] .gt-item-title {
  text-decoration: line-through; color: var(--dsw-alias-label-secondary); }
.gt-meta { display: flex; gap: 2px 0; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-size: 12px;
  line-height: 18px; align-items: center; }
.gt-meta > span { display: inline-flex; align-items: center; }
.gt-meta > span + span::before { content: '·'; margin: 0 6px; opacity: .45; }
.gt-tag { color: var(--dsw-alias-brand-primary); }
/* The dispatch action stays put: hiding the only way to hand work to an agent
   behind a hover makes a lone todo look like it can do nothing. */
.gt-actions { display: flex; gap: 4px; align-items: center; flex: 0 0 auto; }
.gt-attach { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.gt-attach .gt-chip { max-width: 280px; color: var(--dsw-alias-label-secondary); }
.gt-attach a.gt-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.gt-attach-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-menu { position: absolute; top: 40px; right: 10px; z-index: 3; min-width: 184px; display: flex;
  flex-direction: column; padding: 5px; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.gt-menu button { display: flex; align-items: center; gap: 8px; text-align: left; border: none;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 8px 10px;
  border-radius: 7px; cursor: pointer; }
.gt-menu button:hover { background: var(--dsw-alias-button-ghost-active-fill); }
.gt-menu button[data-danger="1"] { color: var(--dsw-alias-state-error-primary); }
.gt-detail { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--dsw-alias-border-l1);
  padding-top: 12px; margin-top: 2px; }
/* Wide screens: the open row's detail becomes a card on the right instead of pushing the list
   down. Deliberately CSS-only over unchanged markup: one detail implementation, and it only
   applies where there is room for a second column. */
/* Wide layout follows the panel's measured width (data-wide), not the viewport. */
  /* Only the list gives way: the title row and the toolbar keep their full width, so the
     controls never wrap or hide behind the card. */
  .gt-root[data-wide="1"][data-wide-detail="1"] .gt-groups { padding-right: 360px; }
  .gt-root[data-wide="1"][data-wide-detail="1"] .gt-inner { position: relative; }
  .gt-root[data-wide="1"][data-wide-detail="1"] .gt-item[data-open="1"] .gt-detail {
    /* Anchored to the panel's own column (.gt-inner), not to the viewport: the slot does not
       always fill the window, and a viewport-centred offset put the card over the list. */
    /* The var fallback matters for the static previews (server-rendered, so effects never
       run): they assume the panel is the centred 980px column. */
    /* border-box matters: 360px is the whole card, so the list's 380px reservation leaves
       a gap instead of overlapping by the padding width. */
    box-sizing: border-box;
    position: fixed; top: var(--gt-detail-top, 208px);
    right: var(--gt-detail-right, max(24px, calc((100vw - 1040px) / 2 + 24px)));
    bottom: var(--gt-detail-bottom, 64px); width: 340px;
    overflow: auto; padding: 16px; margin: 0; border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 12px; background: var(--dsw-alias-bg-overlay); z-index: 30;
  }
.gt-section { display: flex; flex-direction: column; gap: 5px; }
.gt-completion { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.gt-section-title { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-weight: 600; }
.gt-pre { white-space: pre-wrap; word-break: break-word; margin: 0; line-height: 1.6; }
.gt-muted { color: var(--dsw-alias-label-secondary); }
.gt-links { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.gt-link { display: flex; gap: 8px; align-items: center; padding: 4px 0; min-width: 0; }
.gt-link-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.gt-note-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; }
.gt-note-item + .gt-note-item { border-top: 1px solid var(--dsw-alias-border-l1); }
.gt-note-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; }
.gt-note-text { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-width: 68ch; }
.gt-link a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.gt-link a:hover { text-decoration: underline; }
.gt-link-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.gt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gt-banner { border-radius: 9px; padding: 8px 11px; border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gt-activity { display: flex; flex-direction: column; gap: 3px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gt-empty { display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); padding: 42px 16px; text-align: center; flex: 1; }
.gt-empty-title { font-size: 14px; color: var(--dsw-alias-label-primary); }
.gt-foot { color: var(--dsw-alias-label-secondary); font-size: 11px; display: flex; gap: 10px; flex-wrap: wrap;
  align-items: center; }
.gt-toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 50;
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
            // The directory an exemption is keyed on. A group *is* a conversation — the one that
            // wrote these todos — so where it was written is the right key, and it is stored on
            // the record rather than looked up: the conversation may have been unloaded since,
            // and a live lookup answers '' for a session the Host no longer holds. `sessionDir`
            // is about the *bound* session (a hand-off target), a different question, so it is
            // only a fallback.
            dir:
              typeof ordered[0]?.originDir === 'string' && ordered[0].originDir !== ''
                ? ordered[0].originDir
                : typeof ordered[0]?.sessionDir === 'string'
                  ? ordered[0].sessionDir
                  : '',
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
      // Selection is the panel's, not the row's: one batch action spans several rows.
      const selecting = props.selecting === true
      const picked = props.picked === true
      const onPick = typeof props.onPick === 'function' ? props.onPick : () => {}
      // The note box belongs to the row that is open, so its draft lives here.
      const [noteDraft, setNoteDraft] = useState('')
      // Opening a row near the bottom of a long list put the editor below the
      // viewport; the click looked like it did nothing. Bring the row into view
      // when it opens, without yanking the page when it closes.
      const rootRef = useRef(null)
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

      useEffect(() => {
        if (!open) return
        const node = rootRef.current
        if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
      }, [open])

      const dirty =
        draft.title !== todo.title ||
        draft.description !== todo.description ||
        draft.priority !== todo.priority ||
        draft.due !== toLocalInput(todo.dueAt)

      const meta = []
      if (Number.isInteger(todo.seq) && todo.seq > 0) {
        meta.push(h('span', { key: 'seq', className: 'gt-seq', title: t('meta.seqHint') }, `#${todo.seq}`))
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
      meta.push(h('span', { key: 'added', title: new Date(todo.createdAt).toLocaleString() }, ageText(lang, todo.createdAt, now)))
      if (todo.tags.length > 0) {
        const shown = todo.tags.slice(0, 4)
        meta.push(
          h(
            'span',
            { key: 'tags', className: 'gt-tag', title: todo.tags.map((tag) => `#${tag}`).join(' ') },
            shown.map((tag) => `#${tag}`).join(' ') + (todo.tags.length > shown.length ? ` +${todo.tags.length - shown.length}` : ''),
          ),
        )
      }
      if (Array.isArray(todo.notes) && todo.notes.length > 0) {
        const latest = todo.notes[todo.notes.length - 1]
        meta.push(h('span', { key: 'notes', title: latest.text }, t('note.count', { n: todo.notes.length })))
      }
      if (todo.completion !== null && todo.completion !== undefined) {
        meta.push(h('span', { key: 'completed', title: todo.completion.summary }, t('meta.completed', { when: absoluteTime(todo.completion.at) })))
      }
      if (todo.review?.pending === true) {
        meta.push(h('span', { key: 'review', className: 'gt-review', title: t('review.hint') }, t('review.badge')))
      }
      meta.push(h('span', { key: 'by' }, t(`meta.by.${todo.createdBy === 'agent' ? 'agent' : 'human'}`)))
      if (todo.sessionId !== '') {
        const stranded = todo.sessionAlive === true && (todo.sessionDir ?? '') === ''
        meta.push(
          h(
            'span',
            {
              key: 'session',
              className: stranded ? 'gt-chip-warn' : todo.sessionAlive === true ? 'gt-chip-ok' : '',
              title: stranded ? t('meta.session.noDirHint') : (todo.sessionDir ?? ''),
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
          ref: rootRef,
          className: 'gt-item',
          'data-status': todo.status,
          'data-overdue': overdue ? '1' : '0',
          'data-open': open ? '1' : '0',
          'data-selected': picked === true ? '1' : '0',
          role: 'listitem',
        },
        h(
          'div',
          { className: 'gt-item-head' },
          selecting === true
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'gt-pick',
                  'data-on': picked === true ? '1' : '0',
                  'aria-pressed': picked === true,
                  title: picked === true ? t('select.clear') : t('select.label'),
                  onClick: () => onPick(todo.id),
                },
                h(Icon, { name: 'check', size: 11 }),
              )
            : null,
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
            {
              className: 'gt-item-body',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: (event) => {
                if (event.target?.closest?.('a,button,input,textarea,select') !== null) return
                onToggleOpen(todo.id)
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onToggleOpen(todo.id)
              },
            },
            h(
              'div',
              { className: 'gt-item-title' },
              todo.title,
              todo.tags.some((tag) => tag.toLowerCase() === 'inbox')
                ? h('span', { className: 'gt-inbox' }, t('meta.inbox'))
                : null,
            ),
            h(
              'div',
              { className: 'gt-meta' },
              meta,
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
                                : `${link.value}${t('action.copyPathHint')}`,
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
                            title: `${link.value}${t('action.copyPathHint')}`,
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
                className: 'gt-btn gt-btn-quiet',
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
                ...(todo.review?.pending === true
                  ? [
                      { key: 'confirmReview', label: t('review.confirm'), icon: 'check', onSelect: () => onAction('review-confirm', todo) },
                      { key: 'rejectReview', label: t('review.reject'), icon: 'refresh', danger: true, onSelect: () => onAction('review-reject', todo) },
                    ]
                  : []),
                ...(todo.tags.some((tag) => tag.toLowerCase() === 'inbox')
                  ? [
                      { key: 'confirm', label: t('action.confirm'), icon: 'check', onSelect: () => onAction('confirm', todo) },
                      { key: 'discard', label: t('action.discard'), icon: 'trash', danger: true, onSelect: () => onAction('discard', todo) },
                    ]
                  : []),
                {
                  key: 'toggle',
                  label: open ? t('action.hide') : t('action.detail'),
                  icon: 'chevron',
                  onSelect: () => onToggleOpen(todo.id),
                },
                done
                  ? { key: 'reopen', label: t('action.reopen'), icon: 'check', onSelect: () => onAction('reopen', todo) }
                  : { key: 'doing', label: t('action.doing'), icon: 'clock', onSelect: () => onAction('doing', todo) },
                todo.status === 'archived'
                  ? { key: 'unarchive', label: t('action.unarchive'), icon: 'check', onSelect: () => onAction('unarchive', todo) }
                  : { key: 'archive', label: t('action.archive'), icon: 'doc', onSelect: () => onAction('archive', todo) },
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
                { className: 'gt-detail-head' },
                h('span', { className: 'gt-detail-title' }, `${Number.isInteger(todo.seq) && todo.seq > 0 ? `#${todo.seq} ` : ''}${todo.title}`),
                h(
                  'button',
                  { type: 'button', className: 'gt-iconbtn', title: t('action.hide'), 'aria-label': t('action.hide'), onClick: () => onToggleOpen(todo.id) },
                  h(Icon, { name: 'close', size: 13 }),
                ),
              ),
              h(
                'div',
                { className: 'gt-section' },
                h('div', { className: 'gt-section-title' }, t('detail.edit')),
                h(
                  'div',
                  { className: 'gt-field' },
                  h('label', { className: 'gt-field-label', htmlFor: 'gt-edit-title' }, t('field.titleLabel')),
                  h('input', {
                    id: 'gt-edit-title',
                    className: 'gt-input',
                    value: draft.title,
                    onChange: (event) => setDraft({ ...draft, title: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { className: 'gt-field-row gt-edit-meta' },
                  h(
                    'div',
                    { className: 'gt-field' },
                    h('span', { className: 'gt-field-label' }, t('field.priority')),
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
                  ),
                  h(
                    'div',
                    { className: 'gt-field' },
                    h('label', { className: 'gt-field-label', htmlFor: 'gt-edit-due' }, t('field.due')),
                    h('input', {
                      id: 'gt-edit-due',
                      className: 'gt-input',
                      type: 'datetime-local',
                      value: draft.due,
                      onChange: (event) => setDraft({ ...draft, due: event.target.value }),
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'gt-field' },
                  h('label', { className: 'gt-field-label', htmlFor: 'gt-edit-desc' }, t('detail.description')),
                  h('textarea', {
                    id: 'gt-edit-desc',
                    className: 'gt-textarea',
                    value: draft.description,
                    placeholder: t('field.description'),
                    onChange: (event) => setDraft({ ...draft, description: event.target.value }),
                  }),
                ),
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
                          { className: 'gt-note-item', key: `note:${index}:${entry.at}` },
                          h(
                            'div',
                            { className: 'gt-note-meta' },
                            h(Icon, { name: 'doc', size: 12 }),
                            h('span', null, absoluteTime(entry.at)),
                            h('span', null, entry.by === 'agent' ? t('note.by.agent') : t('note.by.human')),
                          ),
                          h('div', { className: 'gt-note-text' }, entry.text),
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

      const [state, setState] = useState({ todos: [], counts: null, health: null, matched: 0, truncated: false })
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      // The static preview asks for a starting view it cannot click its way into.
      const [filter, setFilter] = useState(typeof props.initialFilter === 'string' ? props.initialFilter : 'active')
      const [query, setQuery] = useState('')
      // Multi-select for batch assignment. A separate mode, because the round control on
      // each row already means "done".
      // A manual fallback for the working directory. DSH 0.2.1 mounts the picker by default,
      // so this is what remains for a deployment that leaves it out — and a picker that
      // throws must not leave the user with no way to name a directory at all.
      const [dirDraft, setDirDraft] = useState(null)
      // A folder browser the Host serves (`GET /dirs`). The shell's own picker works in DSH
      // 0.2.1 and is preferred; this keeps the panel usable where it is not mounted, and a
      // page cannot open a native dialog by itself.
      const [browse, setBrowse] = useState(null)
      // The add form used to sit open above the list forever; it is a card you open when
      // you need it, not furniture.
      const [adding, setAdding] = useState(false)
      // The preview harness cannot re-render after a click, so it may ask to start in
      // selection mode; a person toggles it with the `选择` control.
      const [selectMode, setSelectMode] = useState(props.initialSelectMode === true)
      // Only the static preview asks for this: the panel opens settings by click, but the
      // SSR harness cannot click, so the screenshot variant has to start there.
      const initialSettingsOpen = props.initialSettingsOpen === true
      // The picker's filters mirror the shell's own visibility rule, but the shape of the
      // real snapshot has never been observable from here — a preview fixture is written by
      // the same hand as the filter, so it can only confirm itself. Report the shape once per
      // mount so a wrong assumption shows up in `/health.clientErrors` instead of in the UI.
      const shapeReported = useRef(false)
      // The hidden file input behind 导入: a page cannot open a file dialog by itself.
      const importRef = useRef(null)
      const [selected, setSelected] = useState({})
      // One tag field for the whole selection: typing a tag then pressing add applies it to
      // every picked row in one request, which is the batch half that was missing.
      const [bulkTag, setBulkTag] = useState('')
      const [assignBusy, setAssignBusy] = useState(false)
      const [assignAsk, setAssignAsk] = useState(null)
      // A picked file is previewed first: a merge is not undoable, and "did I pick the right
      // export" is exactly the kind of question a dry run answers before anything changes.
      const [importAsk, setImportAsk] = useState(null)
      // One settings popover: reminders and the external door both need a place a person can
      // reach without curl.
      const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen)
      const [keysOpen, setKeysOpen] = useState(false)
      const [settingsBox, setSettingsBox] = useState(null)
      // The detail card's breakpoint follows the panel's own width, not the viewport: the
      // slot is ~265px narrower than the window, so a viewport query opens the two-column
      // layout while the panel is still too narrow for it.
      const [panelWidth, setPanelWidth] = useState(null)
      const [contextOpen, setContextOpen] = useState(false)
      const [tokenDraft, setTokenDraft] = useState('')
      const [ingestDraft, setIngestDraft] = useState(false)
      const [belowDraft, setBelowDraft] = useState('0.8')
      const [remindersDraft, setRemindersDraft] = useState(true)
      const [leadDraft, setLeadDraft] = useState('0')
      const [notificationPerm, setNotificationPerm] = useState(
        typeof window !== 'undefined' && typeof window.Notification === 'function'
          ? window.Notification.permission
          : 'unsupported',
      )
      const notifiedRef = useRef(new Set())
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
      // The archived set, from the same place the sidebar takes it.
      const archivedIds = new Set([
        ...(workspaceSnapshot?.archivedSessionIds ?? []),
        ...(sessionRows?.archivedSessionIds ?? []),
      ])
      /**
       * Would the shell itself show this conversation?
       *
       * Mirrors `sessionVisible` in the shipped workspace package, which is the only
       * authority on this: subagent children are never top-level rows, a blank session is
       * hidden unless it is the one in front of the user, and archived sessions follow the
       * archived filter — this picker offers no archived filter, so they are out.
       *
       * @param {object} row
       * @returns {boolean}
       */
      const reportSessionShape = () => {
        if (shapeReported.current) return
        shapeReported.current = true
        try {
          const sample = Object.values(rows ?? {}).find((row) => row !== null && typeof row === 'object')
          const values = Object.values(rows ?? {})
          reportFailure('sessions-shape', {
            message: JSON.stringify({
              fields: sample === undefined ? [] : Object.keys(sample),
              rows: values.length,
              subagents: values.filter((row) => row?.origin === 'subagent').length,
              blanks: values.filter((row) => row?.blank === true).length,
              archivedFlagged: values.filter((row) => row?.archived === true).length,
              archivedFromWorkspaces: (workspaceSnapshot?.archivedSessionIds ?? []).length,
              archivedFromSessions: (sessionRows?.archivedSessionIds ?? []).length,
            }),
          })
        } catch {
          /* a diagnostic must never break the panel */
        }
      }

      const sessionVisible = (row) => {
        if (row === null || row === undefined) return false
        if (row.origin === 'subagent') return false
        if (row.blank === true && row.id !== currentSessionId) return false
        if (row.archived === true || archivedIds.has(row.id)) return false
        return true
      }
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
            && sessionVisible(row),
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
          ? [{ id: targetValue, title: `${sessionTitles[targetValue] ?? targetValue} · ${t('target.archived')}` }]
          : []
      const conversations = [...pinnedEntry, ...labelled]
      const mounted = useRef(true)
      // The store counts file changes made outside this process (another machine, a sync
      // client). A new count means the panel's view was stale a moment ago; say so once.
      const externalRef = useRef(null)
      // The wide-screen detail card floats over the panel, so its offsets are measured from
      // the panel's own column rather than derived from the viewport width.
      const innerRef = useRef(null)
      const settingsRef = useRef(null)
      const settingsTriggerRef = useRef(null)
      const [detailAnchor, setDetailAnchor] = useState(null)
      const titleRef = useRef(null)
      const searchRef = useRef(null)
      const undoTimer = useRef(null)

      const reload = useCallback(
        async (next = {}) => {
          const selected = next.filter ?? filter
          // Two views sit on top of a status instead of being one: the inbox is a tag over
          // active records, and review is "done, but a person has not agreed yet".
          const status = selected === 'inbox' ? 'active' : selected === 'review' ? 'done' : selected
          const search = next.query ?? query
          try {
            const data = await call('list', {
              query: {
                status,
                ...(selected === 'inbox' ? { tag: 'inbox' } : {}),
                ...(search.trim() === '' ? {} : { query: search.trim() }),
              },
            })
            if (!mounted.current) return
            setState((current) => ({
              ...current,
              // The review view is the done list narrowed to records whose agent
              // completion nobody has answered yet.
              todos:
                selected === 'review'
                  ? data.todos.filter((todo) => todo.review?.pending === true)
                  : data.todos,
              counts: data.counts,
              matched: Number.isInteger(data.matched) ? data.matched : data.todos.length,
              truncated: data.truncated === true,
            }))
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

      /**
       * Re-read the host's mirror of itself.
       *
       * The panel shows Host state (which fence is in force, the automatic-collect
       * switch, completion watching) and writes some of it. Reading it only at mount
       * meant the switch could never show a change it had just made — so it looked
       * impossible to turn off, because the next click sent the same value again.
       */
      const refreshHealth = useCallback(async () => {
        try {
          const data = await call('health')
          if (!mounted.current) return
          const external = Number(data?.store?.externalChanges) || 0
          if (externalRef.current !== null && external > externalRef.current) {
            setNotice({ text: translate(lang, 'notice.externalChange'), sessionId: '' })
            setTimeout(() => setNotice(null), 8000)
          }
          externalRef.current = external
          setState((current) => ({ ...current, health: data }))
        } catch {
          /* the health mirror is not worth an error banner */
        }
      }, [lang])

      useEffect(() => {
        const element = innerRef.current
        if (element === null || typeof window === 'undefined') return undefined
        // The static preview supplies a `window` stub without event plumbing.
        const listen = typeof window.addEventListener === 'function'
        const measure = () => setPanelWidth(element.getBoundingClientRect().width)
        measure()
        if (listen === true) window.addEventListener('resize', measure)
        const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
        if (observer !== null) observer.observe(element)
        return () => {
          if (listen === true) window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [])

      useEffect(() => {
        if (!settingsOpen || typeof window === 'undefined') {
          setSettingsBox(null)
          return undefined
        }
        const measure = () => {
          const element = innerRef.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          setSettingsBox({
            // Just under the title block: high enough that the whole card fits, low enough
            // that it never covers the panel title or the header actions.
            top: Math.round(rect.top + 56),
            right: Math.round(window.innerWidth - rect.right + 20),
            bottom: Math.round(window.innerHeight - rect.bottom + 20),
          })
        }
        const listen = typeof window.addEventListener === 'function'
        measure()
        if (listen === true) window.addEventListener('resize', measure)
        return () => {
          if (listen === true) window.removeEventListener('resize', measure)
        }
      }, [settingsOpen, lang])

      useEffect(() => {
        if (expandedId === '' || typeof window === 'undefined') {
          setDetailAnchor(null)
          return undefined
        }
        const measure = () => {
          const element = innerRef.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          // Bracket the card against the scrolling list, not the panel box: the footer sits
          // below the list, and the panel's own bottom is below that.
          const groups = document.querySelector('.gt-groups')
          const list = groups === null ? null : groups.getBoundingClientRect()
          setDetailAnchor({
            top: Math.round((list === null ? rect.top + 190 : list.top) + 10),
            right: Math.round(window.innerWidth - rect.right + 20),
            bottom: Math.round(window.innerHeight - (list === null ? rect.bottom : list.bottom) + 8),
          })
        }
        measure()
        window.addEventListener('resize', measure)
        // The slot can change width without a window resize (sidebar collapse), which would
        // leave the card at stale coordinates.
        // `window.` on purpose: the static scan rejects a bare global it cannot see defined.
        const Observer = typeof window.ResizeObserver === 'function' ? window.ResizeObserver : null
        const observer = Observer === null ? null : new Observer(measure)
        if (observer !== null && innerRef.current !== null) observer.observe(innerRef.current)
        return () => {
          window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [expandedId, lang])

      useEffect(() => {
        mounted.current = true
        void reload()
        void refreshHealth()
        // One shape report, once the first answers are in: a diagnostic in an effect, not
        // during render, because a render must not have side effects.
        const shapeTimer = setTimeout(() => reportSessionShape(), 1500)
        return () => {
          mounted.current = false
          clearTimeout(shapeTimer)
          if (undoTimer.current !== null) clearTimeout(undoTimer.current)
        }
        // Mount-only: later reloads go through the poll and the toolbar.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void reload()
          void refreshHealth()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [reload])

      // Keyboard: `/` search, `n` new, Escape closes the innermost layer — but never
      // while the user is typing in a field, where the first Escape only drops focus.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => {
          const target = event.target
          const typing =
            target !== null &&
            target !== undefined &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)
          if (event.key === 'Escape') {
            if (typing && typeof target.blur === 'function') target.blur()
            if (keysOpen) {
              setKeysOpen(false)
              return
            }
            if (settingsOpen) {
              setSettingsOpen(false)
              return
            }
            if (adding) {
              setAdding(false)
              return
            }
            setExpandedId('')
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
      }, [settingsOpen, keysOpen, adding])

      // The settings card floats over the list, so a click anywhere else dismisses it
      // the way every other popover on the web does.
      useEffect(() => {
        if (!settingsOpen || typeof document === 'undefined') return undefined
        const onDown = (event) => {
          const card = settingsRef.current
          const gear = settingsTriggerRef.current
          if (card === null) return
          if (card.contains(event.target) === true) return
          if (gear !== null && gear.contains(event.target) === true) return
          setSettingsOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [settingsOpen])

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

      /** A conversation in the todo's own workspace, newest first, skipping archived ones. */
      const sameWorkspaceTarget = (todo) => {
        if (todo === undefined) return ''
        const workspace = workspaceRows.find(
          (row) =>
            (Array.isArray(row.sessionIds) && row.sessionIds.includes(todo.originSessionId)) ||
            (todo.originDir !== '' && row.path === todo.originDir),
        )
        if (workspace === undefined) return ''
        const candidates = (workspace.sessionIds ?? [])
          .filter((id) => id !== todo.originSessionId && !archivedIds.has(id))
          .map((id) => ({ id, at: Number(rows?.[id]?.updatedAt) || 0 }))
          .sort((left, right) => right.at - left.at)
        return candidates.length === 0 ? '' : candidates[0].id
      }

      /**
       * Assign the selected todos.
       *
       * The policy lives on the Host (origin first, then the same-workspace candidate this
       * panel can see, then an explicit choice); this only ships the candidates and reports
       * what came back, including the ones nothing could be found for.
       */
      const runAssign = async (ids, target) => {
        if (ids.length === 0) return
        setAssignBusy(true)
        try {
          const items = ids.map((id) => {
            const todo = state.todos.find((candidate) => candidate.id === id)
            const sessionId = sameWorkspaceTarget(todo)
            return sessionId === '' ? { id } : { id, sessionId }
          })
          const data = await call('assign', {
            method: 'POST',
            body: { ids, items, ...(target === undefined ? {} : { target }) },
          })
          const counts = data.counts ?? {}
          if (counts.assigned > 0) {
            setNotice({
              text: t('assign.summary', {
                n: counts.assigned,
                origin: counts.byOrigin ?? 0,
                workspace: counts.byWorkspace ?? 0,
                chosen: counts.byChoice ?? 0,
              }),
              sessionId: '',
            })
            setTimeout(() => setNotice(null), 9000)
          }
          if (Array.isArray(data.errors) && data.errors.length > 0) {
            setError(new Error(t('assign.failed', { n: data.errors.length, detail: data.errors[0].error })))
          } else if (counts.assigned > 0) {
            setError(null)
          }
          const unmatched = Array.isArray(data.unmatched) ? data.unmatched : []
          setAssignAsk(unmatched.length === 0 ? null : { ids: unmatched })
          setSelected({})
          void reload()
          void refreshHealth()
        } catch (failure) {
          reportFailure('assign', { message: failure?.message })
          setError(failure)
        } finally {
          setAssignBusy(false)
        }
      }

      // The two toggles belong with the other "how this panel behaves" controls, not in
      // the title row.
      const settingsOn = state.health?.settings?.autoCollect === true
      // The Host already knows why it stayed quiet; the switch's tooltip is the cheapest
      // place to show it, and "nothing ever happens" stops being a mystery.
      const autoCollectLast = state.health?.autoCollect?.lastDecision ?? null
      const autoCollectWaiting = Number(state.health?.autoCollect?.waiting) || 0
      const autoCollectDue = Number(state.health?.autoCollect?.due) || 0
      /** Turn a reason code into the sentence a person can read. */
      const reasonText = (code) => {
        const text = typeof code === 'string' ? code : ''
        const known = [
          'off',
          'no-session',
          'no-activity',
          'exempt-workspace',
          'unknown-dir',
          'retry-wait',
          'awaiting-human',
          'not-idle-yet',
          'cooldown',
          'ok',
        ]
        if (known.includes(text)) return t(`autoCollect.reason.${text}`)
        if (text.startsWith('turn-')) return t('autoCollect.reason.turn', { kind: text.slice(5) })
        return text
      }
      const togglesNodes = [
        h(
          'button',
          {
            key: 'select',
            type: 'button',
            className: 'gt-tab',
            'data-on': selectMode ? '1' : '0',
            'aria-pressed': selectMode,
            title: t('select.hint'),
            onClick: () => {
              setSelectMode(!selectMode)
              setSelected({})
            },
          },
          t('select.label'),
        ),
        h(
          'button',
          {
            key: 'auto',
            type: 'button',
            className: 'gt-tab',
            'data-on': settingsOn ? '1' : '0',
            'aria-pressed': settingsOn,
            title:
              t('autoCollect.hint', { n: Number(state.health?.settings?.idleMinutes) || 30 })
              + (autoCollectLast === null
                ? ''
                : `\n${t('autoCollect.last', {
                    reason: reasonText(autoCollectLast.reason),
                    waiting: autoCollectWaiting,
                    due: autoCollectDue,
                  })}`),
            onClick: () => void toggleAutoCollect(!settingsOn),
          },
          t('autoCollect.label'),
        ),
        // The idle window is a number, not a switch: expose it where the switch lives and
        // write on blur, so typing "1" on the way to "120" does not save 1.
        h('input', {
          key: 'idle',
          type: 'number',
          min: 5,
          max: 1440,
          className: 'gt-input gt-input-xs',
          defaultValue: Number(state.health?.settings?.idleMinutes) || 30,
          title: t('autoCollect.idle'),
          'aria-label': t('autoCollect.idle'),
          onBlur: (event) => {
            const next = Number(event.target.value)
            if (!Number.isInteger(next) || next < 5 || next > 1440) return
            void call('settings', { method: 'POST', body: { idleMinutes: next } }).then(() => refreshHealth())
          },
        }),
      ]

      const autoCollectOn = settingsOn
      const autoCollectIdle = Number(state.health?.settings?.idleMinutes) || 30

      /** The switch is Host state: flipping it here writes through `/settings`. */
      const toggleAutoCollect = async (next) => {
        try {
          await call('settings', { method: 'POST', body: { autoCollect: next } })
          // Show it at once; a control that does not move until the next poll reads as
          // broken, and the value it sends must not be the stale one.
          setState((current) => ({
            ...current,
            health:
              current.health === null
                ? current.health
                : {
                    ...current.health,
                    settings: { ...(current.health.settings ?? {}), autoCollect: next },
                  },
          }))
          setError(null)
          setNotice({
            text: next ? t('notice.autoCollectOn', { n: autoCollectIdle }) : t('notice.autoCollectOff'),
            sessionId: '',
          })
          setTimeout(() => setNotice(null), 6000)
          void refreshHealth()
        } catch (failure) {
          reportFailure('settings', { message: failure?.message })
          setError(failure)
        }
      }

      /**
       * Exempt a whole working directory from automatic collect, or take the exemption back.
       *
       * Keyed on the directory rather than on one conversation, because the conversations
       * that need this are the ones a machine drives — a chat companion's session is
       * recreated with a new id when it restarts, and an exemption pinned to an id would
       * quietly stop applying. The path is the stable fact about such a place.
       */
      const toggleExemptWorkspace = async (dir, next) => {
        const currentList = Array.isArray(state.health?.settings?.exemptWorkspaces)
          ? state.health.settings.exemptWorkspaces
          : []
        const wanted = next ? [...currentList, dir] : currentList.filter((entry) => entry !== dir)
        try {
          await call('settings', { method: 'POST', body: { exemptWorkspaces: wanted } })
          // Show it at once, and send the list the panel is actually showing rather than a
          // stale one; `refreshHealth` corrects it if the Host normalised anything.
          setState((current) => ({
            ...current,
            health:
              current.health === null
                ? current.health
                : {
                    ...current.health,
                    settings: { ...(current.health.settings ?? {}), exemptWorkspaces: wanted },
                  },
          }))
          setError(null)
          setNotice({ text: next ? t('notice.exemptOn') : t('notice.exemptOff'), sessionId: '' })
          setTimeout(() => setNotice(null), 6000)
          void refreshHealth()
        } catch (failure) {
          reportFailure('settings', { message: failure?.message })
          setError(failure)
        }
      }

      const exemptWorkspaces = Array.isArray(state.health?.settings?.exemptWorkspaces)
        ? state.health.settings.exemptWorkspaces
        : []

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
          void reload()
          void result
        } catch (failure) {
          reportFailure('capture', { message: failure?.message })
          setError(failure)
        }
      }

      /**
       * Download the list as JSON.
       *
       * The bytes come from the Host's own document (`/export`) rather than from
       * `state.todos`: what is exported has to be what `/import` can hand back
       * unchanged, and the panel's copy carries runtime annotations (a live session's
       * directory, a dead attachment flag) that do not belong in a file.
       */
      const exportJson = async () => {
        try {
          const data = await call('export')
          const doc = data?.doc ?? { todos: [] }
          const text = JSON.stringify(doc, null, 2)
          const url = window.URL.createObjectURL(new window.Blob([text], { type: 'application/json' }))
          const link = document.createElement('a')
          link.href = url
          link.download = 'global-todo-' + new Date().toISOString().slice(0, 10) + '.json'
          link.click()
          window.URL.revokeObjectURL(url)
          setError(null)
          setNotice({ text: t('notice.exported', { n: Array.isArray(doc.todos) ? doc.todos.length : 0 }), sessionId: '' })
          setTimeout(() => setNotice(null), 6000)
        } catch (failure) {
          reportFailure('export', { message: failure?.message })
          setError(failure)
        }
      }

      /**
       * Read a picked JSON file and merge it into the list.
       *
       * Merging, not replacing: this is a personal list, and a file picked by
       * mistake must not be able to erase it. The Host refuses the whole file when
       * any record is unreadable, so a partial import cannot happen here either.
       */
      const importJson = async (event) => {
        const input = event?.target
        const file = input?.files?.[0]
        if (file === undefined) return
        try {
          let parsed
          try {
            parsed = JSON.parse(await file.text())
          } catch {
            throw new Error(t('import.badJson'))
          }
          const preview = await call('import', { method: 'POST', body: { doc: parsed, mode: 'merge', dryRun: true } })
          setError(null)
          setImportAsk({ doc: parsed, summary: preview })
        } catch (failure) {
          reportFailure('import', { message: failure?.message })
          setError(failure)
        } finally {
          if (input !== undefined && input !== null) input.value = ''
        }
      }

      /** The bar from the dry run: this is the step that actually writes. */
      const confirmImport = async () => {
        if (importAsk === null) return
        try {
          const data = await call('import', { method: 'POST', body: { doc: importAsk.doc, mode: 'merge' } })
          setError(null)
          setNotice({ text: t('notice.imported', { n: data?.imported ?? 0, total: data?.total ?? 0 }), sessionId: '' })
          setTimeout(() => setNotice(null), 6000)
          setImportAsk(null)
          void reload()
          void refreshHealth()
        } catch (failure) {
          reportFailure('import', { message: failure?.message })
          setError(failure)
        }
      }

      const applyDir = (value) => {
        const trimmed = String(value ?? '').trim()
        if (trimmed === '') return false
        setPickedDir(trimmed)
        storeStoredDir(trimmed)
        setDirDraft(null)
        setError(null)
        return true
      }

      /**
       * Choose a directory, or let the user type one.
       *
       * `uiWorkspace.pickDirectory()` goes first: DSH 0.2.1 mounts the directory-picker
       * remote by default, so this is the shell's own native dialog. A deployment that omits
       * it throws a bare TypeError ("Cannot read properties of undefined (reading
       * 'directoryPicker')"), which is why the fallbacks stay — a built-in browser and a path
       * field, not an error the person cannot act on.
       */
      /** Walk the Host's directories; `null` closes it. */
      const openBrowse = async (startPath) => {
        setBrowse({ path: startPath ?? '', parent: '', dirs: [], loading: true, error: '' })
        try {
          const data = await call('dirs', {
            query: startPath === undefined || startPath === '' ? {} : { path: startPath },
          })
          setBrowse({ path: data.path, parent: data.parent, dirs: data.dirs ?? [], loading: false, error: '' })
        } catch (failure) {
          reportFailure('dirs', { message: failure?.message })
          setBrowse({ path: startPath ?? '', parent: '', dirs: [], loading: false, error: failure?.message ?? '' })
        }
      }

      const chooseDir = async () => {
        let pick
        try {
          pick = ctx?.get?.('uiWorkspace')?.pickDirectory
        } catch {
          pick = undefined
        }
        if (typeof pick !== 'function') {
          setError(null)
          setNotice({ text: t('dir.pickerMissing'), sessionId: '' })
          setTimeout(() => setNotice(null), 8000)
          void openBrowse(effectiveDir)
          return
        }
        try {
          const chosen = await pick()
          if (typeof chosen === 'string' && chosen !== '') applyDir(chosen)
        } catch (failure) {
          reportFailure('directory-picker', { message: failure?.message })
          setNotice({ text: t('dir.pickerMissing'), sessionId: '' })
          setTimeout(() => setNotice(null), 8000)
          void openBrowse(effectiveDir)
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
        if (kind === 'done') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'done', by: 'human' } }))
        // Answering an agent's completion. Confirming keeps it done; rejecting sends it back
        // to the list, because "not actually done" is the only honest reading.
        if (kind === 'review-confirm') {
          return run(todo.id, () => call('review', { method: 'POST', body: { id: todo.id, decision: 'confirm' } }))
        }
        if (kind === 'review-reject') {
          return run(todo.id, () => call('review', { method: 'POST', body: { id: todo.id, decision: 'reject' } }))
        }
        if (kind === 'reopen') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'open' } }))
        if (kind === 'doing') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'doing' } }))
        // Confirming keeps the record on the list; discarding archives it. Both only remove
        // the "waiting for a person" mark — the provenance tag stays.
        if (kind === 'confirm') {
          return run(todo.id, () => call('bulk', { method: 'POST', body: { ids: [todo.id], removeTags: ['inbox'] } }))
        }
        if (kind === 'discard') {
          return run(todo.id, () => call('bulk', { method: 'POST', body: { ids: [todo.id], status: 'archived', removeTags: ['inbox'] } }))
        }
        // Archive keeps the history without cluttering the list; delete stays a separate,
        // deliberate action reached only through the two-step menu item.
        if (kind === 'archive') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'archived' } }))
        if (kind === 'unarchive') return run(todo.id, () => call('status', { method: 'POST', body: { id: todo.id, status: 'open' } }))
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

      /** Fill the popover from the host's state, so saving cannot send stale values. */
      const openSettings = () => {
        // One inspector at a time: the settings card and the detail card occupy the same side.
        setExpandedId('')
        const current = state.health?.settings ?? {}
        setIngestDraft(current.ingest?.enabled === true)
        setBelowDraft(String(current.ingest?.confirmBelow ?? 0.8))
        setRemindersDraft(current.remindersEnabled !== false)
        setLeadDraft(String(current.reminderLeadMinutes ?? 0))
        setTokenDraft('')
        setSettingsOpen(true)
      }

      const generateToken = () => {
        const bytes = new window.Uint8Array(24)
        window.crypto.getRandomValues(bytes)
        setTokenDraft(Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join(''))
        setIngestDraft(true)
      }

      const saveSettings = async () => {
        try {
          await call('settings', {
            method: 'POST',
            body: {
              remindersEnabled: remindersDraft,
              reminderLeadMinutes: Number(leadDraft),
              ingestEnabled: ingestDraft,
              ingestConfirmBelow: Number(belowDraft),
              ...(tokenDraft.trim() === '' ? {} : { ingestToken: tokenDraft.trim() }),
            },
          })
          setSettingsOpen(false)
          setTokenDraft('')
          await refreshHealth()
          setNotice({ text: t('settings.saved'), sessionId: '' })
          setTimeout(() => setNotice(null), 5000)
        } catch (failure) {
          reportFailure('settings', { message: failure?.message })
          setError(failure)
        }
      }

      /** Acknowledge reminders so the host stops listing them. */
      const ackReminders = async (ids) => {
        try {
          await call('reminders/ack', { method: 'POST', body: { ids } })
          await refreshHealth()
        } catch (failure) {
          reportFailure('reminders', { message: failure?.message })
          setError(failure)
        }
      }

      /** Apply one change to the whole selection; a stale id is reported, not fatal. */
      const runBulk = async (change) => {
        const ids = Object.keys(selected)
        if (ids.length === 0) return
        try {
          const data = await call('bulk', { method: 'POST', body: { ids, ...change } })
          const skipped = (data?.unmatched?.length ?? 0) + (data?.errors?.length ?? 0)
          setNotice({
            text:
              skipped > 0
                ? t('notice.bulkPartial', { n: data?.updated ?? 0, m: skipped })
                : t('notice.bulk', { n: data?.updated ?? 0 }),
            sessionId: '',
          })
          setTimeout(() => setNotice(null), 6000)
          setSelected({})
          setError(null)
          void reload()
          void refreshHealth()
        } catch (failure) {
          reportFailure('bulk', { message: failure?.message })
          setError(failure)
        }
      }

      // Reviewing is a per-record decision, so it cannot ride on /bulk: answering is not a
      // status change, and a rejected claim has to clean up its completion record.
      const runBulkReview = async () => {
        const ids = Object.keys(selected)
        if (ids.length === 0) return
        try {
          const results = await Promise.all(
            ids.map((id) =>
              call('review', { method: 'POST', body: { id, decision: 'confirm' } }).then(
                () => true,
                () => false,
              ),
            ),
          )
          const done = results.filter(Boolean).length
          setNotice({
            text:
              done === ids.length
                ? t('notice.bulk', { n: done })
                : t('notice.bulkPartial', { n: done, m: ids.length - done }),
            sessionId: '',
          })
          setTimeout(() => setNotice(null), 6000)
          setSelected({})
          setError(null)
          void reload()
          void refreshHealth()
        } catch (failure) {
          reportFailure('bulk-review', { message: failure?.message })
          setError(failure)
        }
      }

      const counts = state.counts ?? { total: 0, open: 0, doing: 0, done: 0, cancelled: 0, archived: 0, overdue: 0, inbox: 0 }
      const remindersDue = Array.isArray(state.health?.reminders?.due) ? state.health.reminders.due : []
      const dueKey = remindersDue.map((item) => `${item.id}:${item.dueAt}`).join('|')
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.Notification !== 'function') return
        for (const item of remindersDue) {
          const key = `${item.id}:${item.dueAt}`
          if (notifiedRef.current.has(key)) continue
          notifiedRef.current.add(key)
          if (window.Notification.permission !== 'granted') continue
          try {
            const note = new window.Notification(t('reminder.notifyTitle'), { body: item.title, tag: item.id })
            note.onclick = () => {
              try {
                window.focus()
              } catch {
                /* focus is a nicety */
              }
              setExpandedId(item.id)
            }
          } catch {
            /* a notification is a bonus, never a failure */
          }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dueKey])
      const groups = useMemo(
        () => groupTodos(state.todos, Date.now(), groupMode, sessionTitles, t),
        [state.todos, groupMode, sessionTitles, lang],
      )
      const dispatchLabel =
        targetValue === 'new'
          ? t('action.dispatchNew')
          : targetValue === 'auto'
            ? t('action.dispatchAuto')
            : t('action.dispatch')

      const filterChip = (key, count) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'gt-tab',
            'data-on': filter === key ? '1' : '0',
            'aria-pressed': filter === key,
            onClick: () => {
              setFilter(key)
              void reload({ filter: key })
            },
          },
          count === undefined ? t(`filter.${key}`) : `${t(`filter.${key}`)} ${count}`,
        )

      return h(
        'div',
        {
          className: 'gt-root',
          'data-wide-detail': expandedId === '' ? '0' : '1',
          'data-wide': panelWidth === null || panelWidth >= 960 ? '1' : '0',
          // The slot does not always fill the window, so the card's viewport offsets are
          // measured from the panel itself instead of assumed from 50vw.
          style:
            detailAnchor === null
              ? undefined
              : {
                  '--gt-detail-top': `${detailAnchor.top}px`,
                  '--gt-detail-right': `${detailAnchor.right}px`,
                  '--gt-detail-bottom': `${detailAnchor.bottom}px`,
                },
        },
        h(
          'div',
          { className: 'gt-inner', ref: innerRef },
          h(
            'div',
            { className: 'gt-head' },
            h(
              'div',
              { className: 'gt-headline' },
              h('div', { className: 'gt-title' }, t('panel.title')),
              h('div', { className: 'gt-sub' }, t('panel.subtitle')),
            ),
            h(
              'div',
              { className: 'gt-head-actions' },
              h(
                'span',
                { ref: settingsTriggerRef, style: { display: 'inline-flex' } },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-iconbtn',
                    title: t('settings.title'),
                    'aria-label': t('settings.title'),
                    'aria-expanded': settingsOpen,
                    onClick: () => (settingsOpen ? setSettingsOpen(false) : openSettings()),
                  },
                  h(Icon, { name: 'gear' }),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: adding ? 'gt-btn gt-btn-quiet' : 'gt-btn gt-btn-primary',
                  'aria-expanded': adding,
                  title: adding ? t('action.less') : t('action.add'),
                  onClick: () => {
                    setAdding((value) => !value)
                    setMore(false)
                  },
                },
                h(Icon, { name: adding ? 'close' : 'plus', size: 13 }),
                adding ? '' : t('action.add'),
            ),
            // One overflow menu instead of four competing buttons: the primary action is
            // adding a todo; everything else is occasional.
            h(Menu, {
              label: t('action.overflow'),
              items: [
                { key: 'refresh', label: t('action.refresh'), icon: 'refresh', onSelect: () => void reload() },
                { key: 'export', label: t('action.export'), icon: 'doc', onSelect: () => void exportJson() },
                { key: 'import', label: t('action.import'), icon: 'plus', onSelect: () => importRef.current?.click?.() },
                { key: 'settings', label: t('settings.title'), icon: 'gear', onSelect: () => openSettings() },
                { key: 'keys', label: t('action.keys'), icon: 'kebab', onSelect: () => setKeysOpen(true) },
              ],
            }),
            ),
            h('input', {
              ref: importRef,
              type: 'file',
              accept: '.json,application/json',
              style: { display: 'none' },
              'aria-hidden': 'true',
              onChange: (event) => void importJson(event),
            }),
          ),
          settingsOpen
            ? h(
                'div',
                {
                  ref: settingsRef,
                  className: 'gt-settings',
                  role: 'dialog',
                  'aria-label': t('settings.title'),
                  style:
                    settingsBox === null
                      ? undefined
                      : {
                          position: 'fixed',
                          top: `${settingsBox.top}px`,
                          right: `${settingsBox.right}px`,
                          // Height follows the content, capped by the room below: stretching to
                          // `bottom` left a tall empty card with the footer stranded at the floor.
                          maxHeight: `calc(100dvh - ${settingsBox.top + 20}px)`,
                          zIndex: 40,
                        },
                },
                h(
                  'div',
                  { className: 'gt-settings-head' },
                  h('span', { className: 'gt-settings-title' }, t('settings.title')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-iconbtn',
                      title: t('settings.cancel'),
                      'aria-label': t('settings.cancel'),
                      onClick: () => setSettingsOpen(false),
                    },
                    h(Icon, { name: 'close', size: 13 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'gt-settings-body' },
                  h(
                    'div',
                    { className: 'gt-settings-group' },
                    h('div', { className: 'gt-settings-group-title' }, t('settings.reminders')),
                    h(
                      'label',
                      { className: 'gt-check-row' },
                      h('input', { type: 'checkbox', checked: remindersDraft, onChange: (event) => setRemindersDraft(event.target.checked) }),
                      h(
                        'span',
                        { className: 'gt-check-main' },
                        h('span', { className: 'gt-check-label' }, t('settings.remindersEnable')),
                        h('span', { className: 'gt-hint' }, t('settings.remindersHint')),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'gt-field-row' },
                      h('label', { className: 'gt-field-label', htmlFor: 'gt-lead' }, t('settings.lead')),
                      h('input', {
                        id: 'gt-lead',
                        type: 'number',
                        min: 0,
                        max: 1440,
                        className: 'gt-input gt-input-num',
                        disabled: remindersDraft !== true,
                        value: leadDraft,
                        onChange: (event) => setLeadDraft(event.target.value),
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'gt-settings-group' },
                    h('div', { className: 'gt-settings-group-title' }, t('settings.ingest')),
                    h(
                      'label',
                      { className: 'gt-check-row' },
                      h('input', { type: 'checkbox', checked: ingestDraft, onChange: (event) => setIngestDraft(event.target.checked) }),
                      h(
                        'span',
                        { className: 'gt-check-main' },
                        h('span', { className: 'gt-check-label' }, t('settings.ingestEnable')),
                        h('span', { className: 'gt-hint' }, t('settings.ingestHint')),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'gt-field', 'data-muted': ingestDraft === true ? '0' : '1' },
                      h(
                        'div',
                        { className: 'gt-field-head' },
                        h('label', { className: 'gt-field-label', htmlFor: 'gt-token' }, t('settings.token')),
                        h('button', { type: 'button', className: 'gt-link-btn', disabled: ingestDraft !== true, onClick: generateToken }, t('settings.generate')),
                      ),
                      h('input', {
                        id: 'gt-token',
                        className: 'gt-input',
                        type: 'password',
                        disabled: ingestDraft !== true,
                        value: tokenDraft,
                        placeholder:
                          state.health?.settings?.ingest?.tokenSet === true ? t('settings.tokenSet') : t('settings.token'),
                        autoComplete: 'new-password',
                        onChange: (event) => setTokenDraft(event.target.value),
                      }),
                      h('span', { className: 'gt-hint' }, t('settings.tokenHint')),
                    ),
                    h(
                      'div',
                      { className: 'gt-field-row', 'data-muted': ingestDraft === true ? '0' : '1' },
                      h('label', { className: 'gt-field-label', htmlFor: 'gt-below' }, t('settings.confirmBelow')),
                      h('input', {
                        id: 'gt-below',
                        type: 'number',
                        min: 0,
                        max: 1,
                        step: 0.05,
                        className: 'gt-input gt-input-num',
                        disabled: ingestDraft !== true,
                        value: belowDraft,
                        onChange: (event) => setBelowDraft(event.target.value),
                      }),
                    ),
                    h('span', { className: 'gt-hint' }, t('settings.confirmBelowHint')),
                  ),
                  h(
                    'div',
                    { className: 'gt-settings-group' },
                    h('div', { className: 'gt-settings-group-title' }, t('settings.about')),
                    h(
                      'div',
                      { className: 'gt-about-row' },
                      h('span', { className: 'gt-field-label' }, t('settings.storeFile')),
                      h('span', { className: 'gt-mono gt-settings-path', title: state.health?.store?.file ?? '' }, state.health?.store?.file ?? ''),
                    ),
                    h(
                      'div',
                      { className: 'gt-about-row' },
                      h('span', { className: 'gt-field-label' }, t('settings.version')),
                      h('span', { className: 'gt-mono gt-hint' }, `v${state.health?.version ?? ''} · ${UI_REV}`),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'gt-settings-foot' },
                  h('button', { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => setSettingsOpen(false) }, t('settings.cancel')),
                  h('button', { type: 'button', className: 'gt-btn gt-btn-primary', onClick: () => void saveSettings() }, t('settings.save')),
                ),
              )
            : null,

          // The keyboard hints used to sit in a footer nobody read; they belong where the
          // other occasional things live, one menu away.
          keysOpen
            ? h(
                'div',
                {
                  ref: settingsRef,
                  className: 'gt-settings gt-keys',
                  role: 'dialog',
                  'aria-label': t('action.keys'),
                  style:
                    settingsBox === null
                      ? undefined
                      : {
                          position: 'fixed',
                          top: `${settingsBox.top}px`,
                          right: `${settingsBox.right}px`,
                          maxHeight: `calc(100dvh - ${settingsBox.top + 20}px)`,
                          zIndex: 40,
                        },
                },
                h(
                  'div',
                  { className: 'gt-settings-head' },
                  h('span', { className: 'gt-settings-title' }, t('action.keys')),
                  h(
                    'button',
                    { type: 'button', className: 'gt-iconbtn', title: t('action.hide'), 'aria-label': t('action.hide'), onClick: () => setKeysOpen(false) },
                    h(Icon, { name: 'close', size: 13 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'gt-settings-body' },
                  [
                    ['/', t('keys.search')],
                    ['n', t('keys.new')],
                    ['Enter', t('keys.save')],
                    ['Esc', t('keys.close')],
                  ].map(([combo, sentence]) =>
                    h(
                      'div',
                      { className: 'gt-key-row', key: combo },
                      h('span', { className: 'gt-kbd' }, combo),
                      h('span', { className: 'gt-hint' }, sentence),
                    ),
                  ),
                ),
              )
            : null,

          error !== null
            ? h(
                'div',
                { className: 'gt-banner', role: 'alert' },
                h('span', { className: 'gt-banner-text' }, `${t('error.prefix')}: ${error.message}`),
                h('button', { type: 'button', className: 'gt-btn', onClick: () => void reload() }, t('action.retry')),
                h(
                  'button',
                  { type: 'button', className: 'gt-iconbtn', title: t('action.hide'), 'aria-label': t('action.hide'), onClick: () => setError(null) },
                  h(Icon, { name: 'close', size: 13 }),
                ),
              )
            : null,

          adding
            ? h(
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
                { type: 'button', className: 'gt-btn gt-btn-quiet', 'aria-expanded': more, onClick: () => setMore((value) => !value) },
                more ? t('action.less') : t('action.more'),
              ),
              h(
                'button',
                { type: 'button', className: 'gt-btn gt-btn-primary', disabled: busyId === '__new__' || draft.title.trim() === '', onClick: () => void submit() },
                h(Icon, { name: 'plus', size: 13 }),
                t('action.add'),
              ),
            ),
            more
              ? h(
                  'div',
                  { className: 'gt-new-fields' },
                  h(
                    'div',
                    { className: 'gt-field' },
                    h('label', { className: 'gt-field-label', htmlFor: 'gt-new-desc' }, t('detail.description')),
                    h('textarea', {
                      id: 'gt-new-desc',
                      className: 'gt-textarea',
                      placeholder: t('field.description'),
                      value: draft.description,
                      onChange: (event) => setDraft({ ...draft, description: event.target.value }),
                    }),
                    h('span', { className: 'gt-hint' }, t('field.descriptionHint')),
                  ),
                  h(
                    'div',
                    { className: 'gt-field' },
                    h('label', { className: 'gt-field-label', htmlFor: 'gt-new-links' }, t('detail.links')),
                    h('textarea', {
                      id: 'gt-new-links',
                      className: 'gt-textarea',
                      placeholder: t('field.links'),
                      value: draft.links,
                      onChange: (event) => setDraft({ ...draft, links: event.target.value }),
                    }),
                    h('span', { className: 'gt-hint' }, t('field.linksHint')),
                  ),
                  h(
                    'div',
                    { className: 'gt-field-row' },
                    h(
                      'div',
                      { className: 'gt-field' },
                      h('label', { className: 'gt-field-label', htmlFor: 'gt-new-tags' }, t('field.tagsLabel')),
                      h('input', {
                        id: 'gt-new-tags',
                        className: 'gt-input gt-input-sm',
                        placeholder: t('field.tags'),
                        value: draft.tags,
                        onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'gt-field' },
                      h('label', { className: 'gt-field-label', htmlFor: 'gt-new-due' }, t('field.due')),
                      h('input', {
                        id: 'gt-new-due',
                        className: 'gt-input gt-input-sm',
                        type: 'datetime-local',
                        value: draft.due,
                        onChange: (event) => setDraft({ ...draft, due: event.target.value }),
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'gt-field' },
                    h('span', { className: 'gt-field-label' }, t('field.priority')),
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
                  ),
                )
              : null,
            )
            : null,

          h(
            'div',
            { className: 'gt-toolbar' },
            h('div', { className: 'gt-toolbar-main' },
            h(
              'span',
              { className: 'gt-tabs', role: 'group', 'aria-label': t('filter.label') },
              [
                ['all', counts.total],
                ['active', counts.open + counts.doing],
                ['doing', counts.doing],
                ['done', counts.done],
                ['overdue', counts.overdue],
                // Only shown once something is archived: an empty filter that exists from
                // day one is furniture, not a control.
                ...(counts.archived > 0 ? [['archived', counts.archived]] : []),
                ...(counts.inbox > 0 ? [['inbox', counts.inbox]] : []),
                ...(counts.review > 0 ? [['review', counts.review]] : []),
              ].map(([key, count]) => filterChip(key, key === 'all' ? undefined : count)),
            ),
            h('span', { className: 'gt-divider' }),
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
              { className: 'gt-tabs gt-group-tabs', role: 'group', 'aria-label': t('group.by'), title: t('group.by') },
              GROUP_MODES.map((mode) =>
                h(
                  'button',
                  {
                    key: mode,
                    type: 'button',
                    className: 'gt-tab',
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
              'select',
              {
                className: 'gt-group-select',
                value: groupMode,
                'aria-label': t('group.by'),
                title: t('group.by'),
                onChange: (event) => {
                  setGroupMode(event.target.value)
                  storeStoredGroupMode(event.target.value)
                },
              },
              GROUP_MODES.map((mode) => h('option', { key: mode, value: mode }, t(`group.${mode}`))),
            ),
            ),
            h('div', { className: 'gt-spacer' }),
            h(
              'div',
              { className: 'gt-context-summary' },
              h(
                'button',
                { type: 'button', className: 'gt-chip', title: effectiveDir === '' ? t('dir.none') : effectiveDir, onClick: () => setContextOpen((value) => !value) },
                h(Icon, { name: 'doc', size: 12 }),
                effectiveDir === '' ? t('dir.none') : effectiveDir,
              ),
              h(
                'button',
                { type: 'button', className: 'gt-chip', title: t('target.pick'), onClick: () => setContextOpen((value) => !value) },
                h(Icon, { name: 'play', size: 11 }),
                `${t('target.label')}: ${conversations.find((entry) => entry.id === targetValue)?.title ?? t('target.auto')}`,
              ),
              h(
                'button',
                { type: 'button', className: 'gt-btn gt-btn-quiet', 'aria-expanded': contextOpen, onClick: () => setContextOpen((value) => !value) },
                t('settings.context'),
              ),
            ),
            h(
              'div',
              { className: 'gt-context-details', 'data-open': contextOpen ? '1' : '0' },
            h(
              'span',
              { className: 'gt-dir', title: effectiveDir === '' ? t('dir.none') : effectiveDir },
              h(Icon, { name: 'doc', size: 12 }),
              h('span', { className: 'gt-muted' }, `${t('field.dir')}: `),
              h('span', { className: 'gt-dir-path' }, effectiveDir === '' ? t('dir.none') : effectiveDir),
              h('span', { className: 'gt-muted' }, pickedDir === '' ? t('dir.fromSession') : t('dir.picked')),
              h('button', { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => void chooseDir() }, t('action.pickDir')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'gt-btn gt-btn-quiet',
                  onClick: () => (browse === null ? void openBrowse(effectiveDir) : setBrowse(null)),
                },
                t('dir.browse'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'gt-btn gt-btn-quiet',
                  onClick: () => setDirDraft(dirDraft === null ? effectiveDir : null),
                },
                t('action.typeDir'),
              ),
              pickedDir === ''
                ? null
                : h('button', { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: followSession }, t('action.followSession')),
            ),
            dirDraft === null
              ? null
              : h(
                  'span',
                  { className: 'gt-dir' },
                  h('input', {
                    className: 'gt-input',
                    type: 'text',
                    placeholder: t('dir.manualHint'),
                    value: dirDraft,
                    'aria-label': t('field.dir'),
                    onChange: (event) => setDirDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event?.key === 'Enter' || event?.keyCode === 13) applyDir(dirDraft)
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'gt-btn gt-btn-brand',
                      disabled: String(dirDraft ?? '').trim() === '',
                      onClick: () => applyDir(dirDraft),
                    },
                    t('action.useDir'),
                  ),
                ),
            browse === null
              ? null
              : h(
                  'div',
                  { className: 'gt-browse' },
                  h(
                    'div',
                    { className: 'gt-browse-head' },
                    h('span', { className: 'gt-mono gt-dir-path', title: browse.path }, browse.path === '' ? '…' : browse.path),
                    browse.parent === '' || browse.loading
                      ? null
                      : h(
                          'button',
                          { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => void openBrowse(browse.parent) },
                          t('dir.up'),
                        ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'gt-btn gt-btn-brand',
                        disabled: browse.path === '',
                        onClick: () => applyDir(browse.path),
                      },
                      t('dir.use'),
                    ),
                    h('button', { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => setBrowse(null) }, t('dir.close')),
                  ),
                  browse.error !== ''
                    ? h('div', { className: 'gt-muted' }, browse.error)
                    : browse.loading
                      ? h('div', { className: 'gt-muted' }, t('dir.loading'))
                      : browse.dirs.length === 0
                        ? h('div', { className: 'gt-muted' }, t('dir.empty'))
                        : h(
                            'div',
                            { className: 'gt-browse-list' },
                            browse.dirs.map((dir) =>
                              h(
                                'button',
                                {
                                  key: dir.path,
                                  type: 'button',
                                  className: 'gt-browse-item',
                                  onClick: () => void openBrowse(dir.path),
                                },
                                h(Icon, { name: 'doc', size: 12 }),
                                dir.name,
                              ),
                            ),
                          ),
                ),
            h('span', { className: 'gt-muted' }, `${t('target.label')}: `),
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
            h('span', { className: 'gt-spacer' }),
            h('span', { className: 'gt-tabs', role: 'group', 'aria-label': t('autoCollect.label') }, togglesNodes),
          ),

          selectMode
            ? h(
                'div',
                { className: 'gt-selectbar' },
                h('span', { className: 'gt-selectbar-count' }, t('select.count', { n: Object.keys(selected).length })),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-btn gt-btn-quiet',
                    onClick: () => {
                      // Everything the panel is currently showing, not just the expanded
                      // groups: a collapsed group still holds todos the user means.
                      const visible = state.todos
                      const all = visible.length > 0 && visible.every((todo) => selected[todo.id] === true)
                      setSelected(
                        all
                          ? {}
                          : Object.fromEntries(visible.map((todo) => [todo.id, true])),
                      )
                    },
                  },
                  Object.keys(selected).length === state.todos.length && state.todos.length > 0
                    ? t('select.allOn')
                    : t('select.all'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => setSelected({}) },
                  t('select.clearAll'),
                ),
                h('span', { className: 'gt-spacer' }),
                // In the review view the batch action is confirming, not assigning: every
                // record on screen is finished and waiting for a word.
                filter === 'review'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'gt-btn gt-btn-primary',
                        disabled: Object.keys(selected).length === 0,
                        onClick: () => void runBulkReview(),
                      },
                      t('review.confirm'),
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: filter === 'review' ? 'gt-btn gt-btn-quiet' : 'gt-btn gt-btn-primary',
                    disabled: assignBusy || Object.keys(selected).length === 0,
                    onClick: () => void runAssign(Object.keys(selected)),
                  },
                  assignBusy ? t('assign.working') : t('select.assign'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-btn gt-btn-quiet',
                    disabled: Object.keys(selected).length === 0,
                    onClick: () => void runBulk({ status: 'done' }),
                  },
                  t('select.complete'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-btn gt-btn-quiet',
                    disabled: Object.keys(selected).length === 0,
                    onClick: () => void runBulk({ status: 'archived' }),
                  },
                  t('select.archive'),
                ),
                // In the inbox view the useful batch actions are confirm and discard, not
                // complete: nothing here is done yet.
                filter === 'inbox'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'gt-btn gt-btn-quiet',
                        disabled: Object.keys(selected).length === 0,
                        onClick: () => void runBulk({ removeTags: ['inbox'] }),
                      },
                      t('action.confirm'),
                    )
                  : null,
                filter === 'inbox'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'gt-btn gt-btn-quiet',
                        disabled: Object.keys(selected).length === 0,
                        onClick: () => void runBulk({ status: 'archived', removeTags: ['inbox'] }),
                      },
                      t('action.discard'),
                    )
                  : null,
                h('input', {
                  className: 'gt-input gt-bulk-tag',
                  value: bulkTag,
                  placeholder: t('field.bulkTag'),
                  'aria-label': t('field.bulkTag'),
                  onChange: (event) => setBulkTag(event.target.value),
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-btn gt-btn-quiet',
                    disabled: Object.keys(selected).length === 0 || bulkTag.trim() === '',
                    onClick: () => {
                      const tag = bulkTag.trim()
                      if (tag === '') return
                      void runBulk({ addTags: [tag] })
                      setBulkTag('')
                    },
                  },
                  t('select.addTag'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-iconbtn',
                    title: t('select.done'),
                    'aria-label': t('select.done'),
                    onClick: () => {
                      setSelectMode(false)
                      setSelected({})
                    },
                  },
                  h(Icon, { name: 'close', size: 13 }),
                ),
              )
            : null,

          // Deadlines that passed. The host announces each one once; acknowledging here is
          // what stops it listing them on the next poll.
          remindersDue.length === 0
            ? null
            : h(
                'div',
                { className: 'gt-reminders', role: 'status', title: t('reminder.note') },
                h('span', { className: 'gt-reminders-title' }, t('reminder.title', { n: remindersDue.length })),
                ...remindersDue.slice(0, 3).map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      className: 'gt-reminder-item',
                      title: item.title,
                      onClick: () => {
                        void ackReminders([item.id])
                        setExpandedId(item.id)
                      },
                    },
                    `${item.seq > 0 ? `#${item.seq} ` : ''}${item.title}`,
                  ),
                ),
                notificationPerm === 'default'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'gt-btn gt-btn-quiet',
                        onClick: () => {
                          void window.Notification.requestPermission().then((permission) => setNotificationPerm(permission))
                        },
                      },
                      t('reminder.enableNotifications'),
                    )
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => void ackReminders(remindersDue.map((item) => item.id)) },
                  t('reminder.dismissAll'),
                ),
              ),

          // Nothing could be worked out for these: the user picks one target for them
          // rather than having them sent somewhere nobody chose.
          assignAsk === null
            ? null
            : h(
                'div',
                { className: 'gt-selectbar' },
                h('span', null, t('assign.ask', { n: assignAsk.ids.length })),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gt-btn gt-btn-brand',
                    disabled: assignBusy,
                    onClick: () => void runAssign(assignAsk.ids, { mode: 'auto' }),
                  },
                  t('action.dispatchAuto'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => setAssignAsk(null) },
                  t('action.cancel'),
                ),
              ),

          importAsk === null
            ? null
            : h(
                'div',
                { className: 'gt-selectbar' },
                h(
                  'span',
                  null,
                  t('import.preview', {
                    total: importAsk.summary?.wouldImport ?? 0,
                    create: importAsk.summary?.wouldCreate ?? 0,
                    update: importAsk.summary?.wouldUpdate ?? 0,
                  }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'gt-btn gt-btn-brand', onClick: () => void confirmImport() },
                  t('import.confirm'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'gt-btn gt-btn-quiet', onClick: () => setImportAsk(null) },
                  t('action.cancel'),
                ),
              ),

          loading && state.todos.length === 0
            ? h('div', { className: 'gt-empty' }, t('loading'))
            : state.todos.length === 0
              ? h(
                  'div',
                  { className: 'gt-empty' },
                  h('div', { className: 'gt-empty-title' }, (state.counts?.total ?? 0) === 0 && query.trim() === '' ? t('empty.none') : t('empty.filtered')),
                  (state.counts?.total ?? 0) === 0 && query.trim() === ''
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'gt-btn gt-btn-primary',
                          onClick: () => {
                            setAdding(true)
                            setMore(false)
                          },
                        },
                        t('empty.add'),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'gt-btn gt-btn-quiet',
                          onClick: () => {
                            setQuery('')
                            void reload({ filter: 'active', query: '' })
                          },
                        },
                        t('empty.clearFilter'),
                      ),
                )
              : h(
                  'div',
                  { className: 'gt-groups', role: 'list' },
                  filter === 'inbox' ? h('div', { className: 'gt-inbox-note', role: 'note' }, t('inbox.explain')) : null,
                  groups.map((group) => {
                    const isCollapsed = collapsed[group.key] ?? group.collapsed === true
                    const exemptGroup = typeof group.dir === 'string' && group.dir !== '' && exemptWorkspaces.includes(group.dir)
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
                          h(
                            'span',
                            { className: 'gt-group-count' },
                            group.todos.length === 1 ? t('group.item') : t('group.items', { n: group.todos.length }),
                          ),
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
                        // An exemption is a state, so it keeps a small always-visible mark; the
                        // actions themselves live behind one kebab instead of two text buttons
                        // competing with the group title.
                        exemptGroup
                          ? h(
                              'span',
                              {
                                className: 'gt-group-flag',
                                title: t('action.exemptHintOn'),
                              },
                              h(Icon, { name: 'mute', size: 11 }),
                            )
                          : null,
                        [
                          group.sessionId === undefined
                            ? null
                            : {
                                key: 'capture',
                                label: t('action.captureShort'),
                                icon: 'doc',
                                onSelect: () => void requestCapture(group.sessionId, group.label),
                              },
                          group.dir === undefined || group.dir === ''
                            ? null
                            : {
                                key: 'exempt',
                                label: exemptGroup ? t('action.exemptOn') : t('action.exempt'),
                                icon: 'mute',
                                onSelect: () => void toggleExemptWorkspace(group.dir, !exemptGroup),
                              },
                        ].filter((item) => item !== null).length === 0
                          ? null
                          : h(Menu, {
                              label: t('group.actions'),
                              items: [
                                group.sessionId === undefined
                                  ? null
                                  : {
                                      key: 'capture',
                                      label: t('group.capture'),
                                      icon: 'doc',
                                      onSelect: () => void requestCapture(group.sessionId, group.label),
                                    },
                                group.dir === undefined || group.dir === ''
                                  ? null
                                  : {
                                      key: 'exempt',
                                      label: exemptGroup ? t('group.exemptOff') : t('group.exemptOn'),
                                      icon: 'mute',
                                      onSelect: () => void toggleExemptWorkspace(group.dir, !exemptGroup),
                                    },
                              ].filter((item) => item !== null && item !== undefined),
                            }),
                      ),
                      isCollapsed
                        ? null
                        : h(
                            'div',
                            { className: 'gt-list' },
                            group.todos.map((todo) =>
                              h(TodoItem, {
                        selecting: selectMode,
                        picked: selected[todo.id] === true,
                        onPick: (id) => setSelected((current) => ({ ...current, [id]: current[id] !== true })),
                                key: todo.id,
                                todo,
                                lang,
                                busy: busyId === todo.id,
                                open: expandedId === todo.id,
                                dispatchLabel,
                                onAction,
                                onToggleOpen: (id) => {
                                  setSettingsOpen(false)
                                  setExpandedId((current) => (current === id ? '' : id))
                                },
                              }),
                            ),
                          ),
                    )
                  }),
                ),

          state.truncated === true
            ? h(
                'div',
                { className: 'gt-sub gt-truncated' },
                t('list.truncated', { shown: state.todos.length, matched: state.matched }),
              )
            : null,

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
        activeLang = resolveLang(ctx)
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
          const lang = this.props.componentProps?.lang ?? activeLang
          return h(
            'div',
            { className: 'gt-root' },
            h(
              'div',
              { className: 'gt-inner' },
              h(
                'div',
                { className: 'gt-banner', role: 'alert' },
                translate(lang, 'boundary.error', { message }),
                h('button', { type: 'button', className: 'gt-btn', onClick: this.retry }, translate(lang, 'action.retry')),
              ),
            ),
          )
        }
        return h(this.props.component, this.props.componentProps)
      }
    }

    // ------------------------------------------------------------------ apply

    return {
      inject: ['sessions', 'uiWorkspace', 'slots', 'locale'],

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
