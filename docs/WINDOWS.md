# Windows

Issue #2 was a Windows-only save failure that shipped for months because CI only ever ran Linux:
the atomic write reopened its temp file read-only and called `fsync`, which on Windows is
`FlushFileBuffers` and requires a writable handle. Every save threw `EPERM` **before** the rename,
so the list looked empty while the data piled up as `*.tmp` debris. Fixed in 0.12.6.

This file is the checklist that keeps that from happening again, and the script a tester on a real
Windows machine should run.

## What the test suite already covers on every platform

| Area | Where | What it pins |
|---|---|---|
| atomic write | `test/atomic-write.test.mjs` | the temp file is opened for **writing**; a refused `fsync` warns instead of losing the save; a failed write leaves no debris |
| rename under a lock | `test/windows.test.mjs` | `EPERM`/`EBUSY`/`EACCES` are retried (bounded), other errors fail at once, no temp file survives a real failure |
| workspace paths | `test/windows.test.mjs` | `C:\\dev\\demo`, `C:/dev/demo` and `\\\\server\\share` are accepted as exemptions; relative paths are not |
| CRLF markdown | `test/windows.test.mjs` | a document saved on Windows imports like the same document saved on Linux |
| install shape | `test/manifest.test.mjs` | `locale/` ships and the `./locale/*.json` export exists (the desktop metadata error) |

CI runs the suite on **ubuntu-latest and windows-latest** (node 22.19 on both, node 24 on Linux).
Windows runs `node tools/windows-check.mjs` as an extra step.

That matrix earned its keep on its first day: it found four things Linux could not see — a `mkdir`
over a file reporting `EEXIST` instead of `ENOTDIR`, the diagnostics trim losing a rename to a busy
reader, `tools/preview.mjs` creating a directory named `panel.html` (a POSIX-only regex), and two
test assertions that pinned POSIX literals. All fixed in 0.12.8.

## The real-filesystem check

```powershell
git clone https://github.com/LUgABeEEE/dsh-global-todo
cd dsh-global-todo
node tools/windows-check.mjs      # or: npm run check:windows
```

It uses `os.tmpdir()` and does seven things a faked `fs` cannot: create a store, update/complete/
review then reload, assert no `.tmp` debris, write and read back 500 todos, import a CRLF Markdown
file, write into a path with spaces and non-ASCII characters, and rename over an existing file. It
prints one line per check and exits non-zero on the first failure.

## 0.16 新增：这张清单是为了让新功能先在你那台机器上过一遍

0.12—0.15 加的东西里有四项**能在 Windows 上表现得和 Linux 不同**，其中两项直接碰到路径与文件存在性。
每一项都写清了「怎么做」和「什么样才算通过」，照着走一遍即可，不需要读代码。

### 1. 图片附件（0.15.0，最需要真机验证）

附件现在可以有第三种类型 `kind: "image"`，它和文档一样是**引用**（不复制字节），但面板会渲染它。

准备工作（PowerShell，路径里故意带空格和中文）：

```powershell
$dir = Join-Path $env:TEMP 'gt 图片 测试'
New-Item -ItemType Directory -Force $dir | Out-Null
# 先写一张 1x1 的合法 PNG，保证没有 Pictures 目录的机器也能照着走：
[IO.File]::WriteAllBytes(
  (Join-Path $dir 'shot.png'),
  [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
)
# 想用真实截图（名字里带空格/中文）就再拷一份：
Copy-Item "$env:USERPROFILE\Pictures\*" $dir -ErrorAction SilentlyContinue
Get-ChildItem $dir | Select-Object Name, Length
```

| 步骤 | 期望 |
|---|---|
| 新建一条待办，附件给 `{ "kind": "image", "value": "<上面的路径>\shot.png" }`（或用工具 `global_todo_add` 的 `links`） | 行上出现 16px 缩略图，详情里出现预览图 |
| 把那张 png 改名（`Rename-Item`），刷新面板 | 变成红色的「文件不在了」chip，**不是一张破图** |
| 用详情里的「重新挂载」把它指回改名后的文件 | 缩略图恢复，且类型仍是 image（不会变成文档） |
| 给一个 `.svg` 作为 image | 被拒绝，错误里有「图片附件需要图片扩展名」 |
| 给一个 >8MB 的图片 | 面板提示「图片超过 8MB」，缩略图不加载 |
| 路径用反斜杠、带盘符（`D:\…\shot.png`） | 与正斜杠一致；`C:/…/shot.png` 也可以 |

后端可直接验（服务在本机时）：

```powershell
# 换成真实 id 与索引；路径只从记录里取，请求里传路径会被忽略
curl.exe -s "http://127.0.0.1:3080/api/global-todo/asset?id=<id>&index=0" -o $env:TEMP\probe.png
Get-Item $env:TEMP\probe.png | Select-Object Length
```

### 2. 重新挂载（0.16.0）

- 详情里**只有失效附件**才出现「重新挂载」按钮；点开是内联输入框，预填旧路径；
- 保存后**原地替换**（附件顺序、标题、类型都不变），不会变成一条新附件；
- 换成一个**非**绝对路径（如 `notes.md`）应被拒绝；换成一个不存在的路径：若 `requireExistingFiles` 默认为真，也会被拒绝——这正是设计意图，先建文件再挂。

### 3. 搜索的 `before:` / `after:`（0.16.0）

| 输入 | 期望 |
|---|---|
| `before:2026-11-01` | 只留下**截止时间早于本地 11-01 00:00** 的条目；等于该时刻的不算。纯日期按**本地零点**锚定（0.16.2 起；此前锚在 UTC 零点，+08 上会吞掉边界日 00:00–08:00，见 issue #6） |
| `after:2026-10-01` | 只留下截止时间晚于该时刻的；**没有截止时间的条目两个方向都不出现** |
| `after:2026-10-01 before:2026-12-01` | 两个条件同时生效（AND） |
| `before:2026-1`（没打完） | **不报错**，该 token 退化成普通搜索词；这不是 bug |
| `before:2026-02-31` | 同上：非法日期不当作边界，也不会被当成 3 月 1 日 |

注意时区：无时区的日期按**本机本地时间**解释，与截止时间输入框的行为一致。如果你的机器是 +08:00，`before:2026-11-01` 指的是本地 11 月 1 日 00:00。

### 4. 读屏（0.16.0）

用 NVDA 或 Windows 讲述人过一遍：

| 位置 | 期望 |
|---|---|
| 分组头（会话 / 时间 / 级别 三种分组下都有） | 朗读「已展开 / 已收起」；用键盘 Space/Enter 可切换 |
| 顶部筛选（全部 / 未完成 / …） | 当前筛选项朗读为「已按下」 |
| 操作提示（例如「已让某对话抓取」） | 作为状态区域被朗读一次，不会抢焦点 |
| 错误横幅 | 立即朗读（alert） |
| 纯图标按钮（关闭、更多、保存等） | 有可读名称，不是「按钮」两个字 |

> 验证方法：这些状态是**读屏软件从 ARIA 属性原生翻译**出来的，所以查代码里是否挂了属性
> （`aria-expanded` / `aria-pressed` / live region），**不要**去源码里搜「已展开」「已按下」字面量——
> 那样会误判成 FAIL（`#6` 里对方第一版就是这么误判的，随后自己更正）。

### 回归（每次都跑，10 秒）

```powershell
npm run check:windows      # 7 项真实文件系统冒烟
npm run check:contracts    # 64 项跨字段契约，模块级、离线
node --test test/lock.test.mjs   # 7 项文件锁，其中一项真的起两个进程
```

两项都过，再填上面四节的表格。哪一格和期望不符，就按「What to report if something fails」的四条信息回给我。

## 0.18 新增：文件锁（跨进程写）

从 0.18.0 起，每次写之前先独占建出 `todos.json.lock`，写完删掉。Windows 上这条路径有三个只有
真机能确认的点：

1. **独占创建真的排他**：开两个宿主进程（Web 面板 + 桌面端 / 命令行会话，或把同一份 `todos.json`
   放在 OneDrive / 同步盘），两边各点几次「添加」。两边都不该丢条目；偶尔看到 `store-busy`（HTTP 503）
   是排队超时，不是 bug——重试一次即可。
2. **磁盘上不该有残留**：正常退出后 `%USERPROFILE%\.dsh\global-todo\` 里只有 `todos.json` 和
   `settings.json`。若出现 `todos.json.lock`，把里面的 `pid` / `host` 一起报给我——那通常说明
   删除被占用（杀毒软件、同步盘客户端），后续写入会等到超时。
3. **强杀之后还能写**：用任务管理器杀掉持有锁的那个进程，再在另一个进程里添加一条。应当**立刻**
   写入成功（同一台机器按 pid 判死，不等 30 秒），日志里会有一条「清掉一个过期的写锁」。

## 常设三问：每版发版前必答

三轮 Windows 测试（#2/#4/#5/#6）打的都是同一类 bug：**同一个值在两层或两平台被不同规则解释**，而每层单测都绿。
所以除了上面具体的功能清单，发版前固定问这三句：

1. **两层口径**：新字段/新解析器在 **HTTP 校验层**与**文件容错层**的行为是否都有定义，且文档说的是同一件事？
   （`#5` 的 `null`、`#3` 的 `settings` 形状，都是这一问漏掉的。）
2. **时区**：新的时间/日期输入，在**非 UTC 机器**上过判别对了吗？要覆盖边界日本身、非整点时区、DST。
   （`#6` 就是这一问：`Date.parse('YYYY-MM-DD')` 是 UTC 零点，而 `dueAt` 按本地录。）
3. **路径四态**：新的路径处理，**盘符 / 反斜杠 / UNC / 大小写**都过了吗？（`#2`、`#3` 的豁免路径、Windows 测试轮都在这。）

这三问的教训来源是 Windows 测试轮 #2–#6；有 `npm run check:contracts` 兜住一半，剩下的一半只能靠发版前问。

## What to report if something fails

1. the check name from the `FAIL` line and the full message;
2. `node -v`, `dsh --version`, Windows build (`winver`);
3. whether the data directory is on a network drive, OneDrive, or a synced folder — those change
   `fsync`/`rename` semantics more than the OS version does;
4. the contents of `%USERPROFILE%\.dsh\global-todo\` (file names are enough; redact titles if you
   prefer) — `*.tmp` files are evidence of a write that never renamed.

## Known Windows behaviours that are *not* bugs

- **A `*.tmp` file can briefly appear** while a write is in flight. After a successful save it is
  gone; after a failed one it is removed by the writer.
- **Antivirus can hold a handle for a few milliseconds.** That is why the rename is retried rather
  than reported on the first `EPERM`.
- **Paths longer than 260 characters** depend on the machine's `LongPathsEnabled` policy; the plugin
  uses normal Node file APIs, so it inherits that limit rather than working around it.
- **Case**: workspace exemptions are compared case-insensitively on Windows only.
