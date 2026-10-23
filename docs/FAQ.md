# 常见问题

14 个真问题，答案都能在代码里核对。文中路径相对仓库根；`$DSH_HOME` 默认是 `~/.dsh`。

## 1. 我的数据到底存在哪？卸载会删掉吗？

默认 `$DSH_HOME/global-todo/todos.json`，可以用插件配置的 `storePath` 指到任意绝对路径
（`lib/store.js` 的 `resolveStorePath`）。同一个目录里还有 `settings.json`（宿主侧开关）和
`client-errors.log`（面板错误日志，有上限）。

安装和卸载都**不碰**这些文件。卸载后手动 `rm -r` 那个目录才会彻底清掉。

## 2. 两台机器之间会同步吗？

不会。插件没有账号、没有同步服务，也不发网络请求——它只读写那一个文件。

跨机使用靠你自己：把 `storePath` 指到同步盘或版本库里的同一份文件，同步交给 Dropbox / Syncthing /
git 那套工具。另一个进程改了文件，本进程下一次读会通过 `mtime:size` 发现，面板提示
「清单在别处被改过，已载入最新内容」。

注意：**没有合并逻辑**。两边同时改，最后落盘的那份赢，另一边那次改动丢失（见第 9 题）。

## 3. Agent 把一条标成完成之后会发生什么？

记录变成 `done`，同时带上 `review: { pending: true }`（`lib/model.js` 的 `completeTodo`）。
清单里两处可见：行上的「待确认」徽标，顶部的「待确认」筛选与计数。

| 你的回答 | 结果 |
|---|---|
| 确认完成 | 保持已完成，标记清除，动态里记下是谁确认的 |
| 退回清单 | 回到 `open`；`doneAt` 和完成记录清空；动态里加一条 `reopened` |

派发出去的会话干净结束时，自动收尾也走同一条规则——自动完成同样是「agent 的声明」，一样要人回答。

## 4. 已经有 steps 了，为什么不做子任务？

因为子任务就是另一条待办：要有自己的 id、状态、加入时间、附件、派发目标和完成记录。真做出来，
「一份清单」就变成了「一堆互相嵌套的清单」。

`steps` 明确是**一条工作里的计划**：扁平、最多 20 步、每步只有 `text` 和 `done`，派发时作为编号
计划原样交出去。需要各自派发的，就拆成多条待办——那才是清单该有的粒度。

## 5. evidence（原话）是什么？为什么有的条目没有？

抓取时逐字引用的那一句用户原话，最多 300 字（`lib/model.js` 的 `LIMITS.evidence`）。
`global_todo_capture` 会要求模型带上，`global_todo_add` 也收。

面板详情里显示在「原话」下；Markdown 导出里是 `原话:` 一行。你在面板里手敲的条目没有这一项——
它只服务于「抓来的东西有没有听错」这件事。

## 6. 怎么从别的工具导进来？

三个门，按需要选：

| 入口 | 形状 | 行为 |
|---|---|---|
| JSON 文档 | `{ "version": 1, "todos": [...] }` | 面板「更多操作 → 导入」，或 `POST /api/global-todo/import`；面板用 merge（同 id 覆盖、新 id 追加），`dryRun: true` 只返回 `wouldCreate` / `wouldUpdate` |
| Markdown | `- [ ] 标题` 任务列表，缩进标注 `优先级 / 截止 / 标签 / 原话 / 描述 / 附件 / #` | 同上，选 `.md` 文件；按 `create` **新建**，没有 id 所以不会覆盖任何记录 |
| 外部写入 | `POST /api/global-todo/ingest`，带 `Authorization: Bearer <settings.ingestToken>` | 来源只接受 `mail / notification / announcement`；一次最多 100 条；置信度低于 `ingestConfirmBelow`（默认 0.8）的进收件箱 |

CSV 没有直接入口：先转成 JSON 或 Markdown。Markdown 解析是容错的——不认识的行忽略，日期解析失败
就丢掉那一项，整份文件里一行任务都没有才会报错。

## 7. 不用 Agent 也能用吗？

能。面板只依赖宿主的 web server 和那个 JSON 文件：增删改查、标签、优先级、截止、步骤、附件、
筛选、搜索、导出导入、提醒都不需要 Agent。`global_todo_*` 工具只是可选挂载面。

没有 Agent 参与时用不上的只有四件事：抓取、派发、Agent 的完成声明、会话回读。

## 8. 哪些功能目前还没有？

| 目前没有 | 现状 |
|---|---|
| 看板 / 日历视图 | 现在只有列表，加三种分组（对话 / 时间 / 级别）；没有拖拽看板，没有日历 |
| 重复任务 | `dueAt` 是单个时间点，还没有 recurrence 字段；同一截止只提醒一次，改了时间才会重新提醒 |
| 子任务树 | 现在只有扁平的 `steps`，最多 20 条 |
| 上传附件 | 现在只存引用（绝对路径或 URL），不复制字节 |
| 多清单 / 项目 | 现在只有一份全局清单 |
| 自动开工 | 现在没有；它是一份个人清单，不是任务队列 |
| 桌面端面板 | 现在只有 Web 客户端 |
| 账号 / 多用户 | 现在没有；只有一个本机（或受信网络）可访问的 HTTP 面 |

## 9. 两个进程同时写这个文件会怎样？

同一个进程里，所有写都走 `store.update` 这条串行链，人和 Agent 的编辑不会互相覆盖。

跨进程**没有文件锁**。每次改动是「读整份 → 改 → 原子 rename 写回」，所以：

- 读者永远不会看到半截文件（rename 是原子的）。
- 两个进程同时改时，后写的那份覆盖先写的，基于旧内容的那次改动静默丢失。
- 下次读会发现 `mtime:size` 变了，面板提示清单在别处被改过。

结论：**别让两个宿主进程共用同一个 `storePath`**。要并行，就各自一份文件，再用导出/导入合并。

## 10. 提醒是怎么工作的？

宿主每 30 秒扫一次（`lib/index.js` 的 reminder tick）：状态是 `open` / `doing`、`dueAt` 已过、
且这个 `id → dueAt` 还没报过的条目，进 `/health` 的 `reminders.due`，面板顶部显示成一条提醒条。

| 设置 | 默认 | 作用 |
|---|---|---|
| `remindersEnabled` | 开 | 关掉就不再扫、不再显示 |
| `reminderLeadMinutes` | 0 | 提前几分钟报；0 = 到点才报 |

点「知道了」调 `POST /api/global-todo/reminders/ack`，只从**当前进程**的提醒列表里移除。
「报过了」的记忆也在内存里，所以重启宿主后，仍然到点且未完成的条目会再报一次。
浏览器通知是可选的：面板里点「开启系统通知」授权后，到点的条目会发一条系统通知。

## 11. 怎么关掉自动获取（auto-collect）？

先分清三件不同的事：

| 开关 | 默认 | 管什么 | 怎么关 |
|---|---|---|---|
| `autoCollect` | **关** | 插件自动去问一个安静了 30 分钟的对话「有没有要跟进的事」 | 面板设置里的「自动获取」开关，或 `POST /api/global-todo/settings { autoCollect: false }` |
| `guidance` | 开 | 往 system prompt 里注入「主动记」的引导 | 插件配置 `guidance: false` |
| 对话分组上的「豁免」 | 无 | 把某个**工作目录**整个排除在自动获取之外 | 再点一次取消 |

「抓一下待办」/「从本对话抓取」不在此列：那是你手动触发的，永远听你的。

## 12. 怎么干净卸载？

```sh
dsh plugin --profile <profile> remove dsh-global-todo
```

然后重启宿主、刷新页面，侧栏入口消失。清单和设置都还在原处——这是刻意的。

要彻底清掉（先确认里面的 `todos.json` 你不要了）：

```sh
rm -r "$DSH_HOME/global-todo"
```

更稳的顺序：先导出 JSON 或 Markdown，再删目录。重新装回来后，把导出的 JSON 用「更多操作 → 导入」
就能接着用。

## 13. 收件箱和「待确认」有什么区别？

| | 收件箱（Inbox） | 待确认（Review） |
|---|---|---|
| 谁产生的 | 外部写入（`/ingest`），置信度低于阈值 | Agent 的完成声明（工具或自动收尾） |
| 问题是什么 | 「这条要不要收下」 | 「这活是不是真做完了」 |
| 两个动作 | 确认（去掉 `inbox` 标签进清单）/ 丢弃（归档并去掉标签） | 确认完成 / 退回清单 |
| 不处理会怎样 | 超过 7 天自动归档（宿主每 6 小时扫一次） | 一直挂着，行上一直有「待确认」 |

## 14. 派发失败最常见的原因？

| 原因 | 表现与处理 |
|---|---|
| 没有工作目录 | 明确报错，因为没有目录的会话里 agent 做不了事；改用「开新对话」，或先选目录 |
| 目标对话已归档 | 选择器里标「（已归档）」；换一个，或新开 |
| 宿主没有 agents 服务 | `agents-unavailable`：精简组合里没有能接活的 agent |
| `bound` 模式但没绑定 | 直接告诉你没有绑定会话，并建议改用 `auto` |

失败一定带原因，也记在详情的「最近派发」里；不会静默什么都不做。


## 15. 桌面端报 `Plugin metadata … ENOENT … \locale` 是什么？

**插件本身已经加载了，这是「显示文字」取不到**，不影响面板和工具。宿主读插件页标题/描述的顺序是：
先解析 `<包>/locale/en.json`（走 `exports` 里的 `./locale/*.json`），解析成功后**扫这个目录**，
把 `zh.json`/`en.json` 逐个读进来。目录不存在，扫描就抛 ENOENT，于是元信息报错。

也就是说：**你那份本地插件目录缺 `locale/` 文件夹**。常见于把仓库文件夹手动复制到
`%USERPROFILE%\.dsh\plugins-local\` 时只拷了 `lib`、`package.json`、`cordis.patch.yml`。

先确认到底缺什么，别靠猜：

```sh
npx dsh-global-todo-doctor "$HOME/.dsh/plugins-local/全局待办插件"
# Windows: npx dsh-global-todo-doctor "$env:USERPROFILE\.dsh\plugins-local\全局待办插件"
```

它逐项检查 `package.json`、patch 文件、两个入口、`locale/`、图标与 `lib/`，缺哪样直接点出来，
缺必需项时退出码为 1（可以放进安装脚本里当门禁）。

修法二选一：

1. **推荐**：别用本地目录，直接装 npm 包（包里有 `locale/en.json`、`locale/zh.json`）：

   ```powershell
   dsh plugin add dsh-global-todo
   ```

2. 保留本地目录，把缺的补齐（`$src` 换成仓库或 npm 包里那份）：

   ```powershell
   $dst = "$env:USERPROFILE\.dsh\plugins-local\全局待办插件"
   $src = "C:\path\to\dsh-global-todo"
   New-Item -ItemType Directory -Force "$dst\locale" | Out-Null
   Copy-Item "$src\locale\*.json" "$dst\locale\" -Force
   Copy-Item "$src\docs\icon.svg" "$dst\docs\" -Force   # 图标同理会报错
   ```

   然后重启宿主（插件元信息在启动时读一次）。

为什么会这么脆：`exports` 的 `./locale/*.json` 是**通配映射**，Node 解析它时不检查文件是否存在，
所以宿主以为文件在、去扫目录，才发现没有。完整安装不会触发；只有手工拷半份才会。
