# 面板基线截图

`docs/screenshots/` 下的图不是手拍的。`npm run screenshots` 先跑 `npm run preview`，把真实的客户端
半区渲染成静态 HTML（不依赖宿主、零依赖），再由 `tools/screenshot.mjs` 以 1280×720 拍下来。
这些图随包发布，也嵌在两份 README 里，所以面板 UI 一改就要重跑。

## 图与状态

| 文件 | 显示的状态 | 重新生成 |
|---|---|---|
| [`panel.png`](panel.png) | 默认列表：计数胶囊、按对话分组、级别与逾期标记 | `npm run screenshots` |
| [`panel-detail.png`](panel-detail.png) | 展开一条：就地编辑、附件（含失效标记）、步骤与勾选、进展记录、会话状态、动态 | `npm run screenshots` |
| [`panel-select.png`](panel-select.png) | 批量选择：勾选标记、选择条、批量动作 | `npm run screenshots` |
| [`panel-settings.png`](panel-settings.png) | 设置：分组字段、每项说明、保存行 | `npm run screenshots` |
| [`panel-empty.png`](panel-empty.png) | 空清单 | `npm run screenshots` |
| [`panel-filtered.png`](panel-filtered.png) | 筛选无结果 | `npm run screenshots` |
| [`panel-inbox.png`](panel-inbox.png) | 收件箱：等确认的外部条目 | `npm run screenshots` |
| [`panel-review.png`](panel-review.png) | 待确认：Agent 已完成、等人回答 | `npm run screenshots` |
| [`panel-reminders.png`](panel-reminders.png) | 到点提醒条 | `npm run screenshots` |
| [`tour.gif`](tour.gif) | 十帧幻灯片（列表 → 详情 → 列表 → 待确认 → 列表 → 收件箱 → 列表 → 提醒 → 列表 → 选择），2 秒一帧 | `npm run tour`（需要 ffmpeg；没有就跳过） |
| [`demo.mp4`](demo.mp4) | 22 秒**排版演示**：暗色主题下 2× 渲染的真实面板，五个主张逐屏给出，配轻音效、无旁白 | 见 [`docs/DEMO.md`](../DEMO.md)，`tools/demo/` 下四个步骤 |
| [`demo-poster.png`](demo-poster.png) | 上面视频的首帧海报（12 秒处），给不自动播放的环境 | 从 `demo.mp4` 抽一帧 |

`npm run screenshots` 会重写九张 PNG（顺序见 `tools/screenshot.mjs` 的 `SHOTS`）；`npm run tour` 只重做
gif，并要求 PNG 已经存在。`demo.mp4` 是**另一条流水线**：它必须由真实浏览器录制，静态渲染做不到滚动、
悬停和点击 —— 见 `docs/DEMO.md`。

## 手机档

`mobile/` 下三张是 390×844 的手机基线，由 `npm run screenshots:mobile` 生成（先 `tools/preview.mjs
--mobile` 把同一棵组件按 390px 渲染，夹具会把面板的实测宽度答成 390，所以走的是真的窄屏分支）：

| 文件 | 显示的状态 |
|---|---|
| [`mobile/panel.png`](mobile/panel.png) | 手机列表：44px 触摸目标、筛选可横滑、行内动作收成图标 |
| [`mobile/panel-detail.png`](mobile/panel-detail.png) | 手机详情：单列表单、进展记录（拍前先滚动到展开行） |
| [`mobile/panel-settings.png`](mobile/panel-settings.png) | 手机设置：贴两边、内容滚动、底部保存行固定 |

## 这些图证明不了什么

它们是**服务端渲染的静态基线**，不是浏览器里真的会话：

- **不能滚动**：只覆盖 1280×720 的第一屏。滚动后的样子、以及滚动本身有没有坏，都不在图里。
- **不能聚焦 / 悬停**：键盘焦点环、悬停才出现的行内操作、展开的下拉菜单都不在图里。
- **不能证明交互**：点击、拖拽、动画、真实网络请求（预览里用的是桩数据）都没有经过。

`npm run check:render` 补上了一部分：它断言渲染结果里的结构事实（分组合并、徽标、选择模式、步骤进度，
面板裁剪 / 列可收缩 / 列表可滚这三条布局契约，以及手机档真的被走到的分支与那几条触摸/安全区/字号规则）。
其余仍要在真实页面里看 —— 手机档尤其如此：真实 WebView 的 `env(safe-area-inset-*)`、软键盘弹出时的
可视区变化、以及惯性滚动，都不是静态图能证明的。

## 两个不在生成列表里的文件

`panel-dark.png` 与 `detail-dark.png` 不在 `tools/screenshot.mjs` 的 `SHOTS` 里，任何脚本都不会重新生成
它们，当前也没有文档引用。当作历史文件处理，别拿它们当主题基线。
