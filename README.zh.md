# dsh-global-todo · 全局待办

**中文完整说明已经并入 [`README.md`](README.md) 的前半部分**——GitHub 与 npm 默认渲染的就是那一份，
中文在前、英文在后；两半顶部都有 **中文 / English** 一行可以互相跳转。这个文件只留着，让旧链接还能落地。

一句话：一份跨会话的待办清单，一个属于你的 JSON 文件，你和 Agent 读写同一份。
**中心规则是：Agent 说「做完了」不算完成**——它自己在工具里报的、或者交给的会话干净收尾后宿主自动
收尾的，都只进「待确认」，人点头才算完成。

```sh
dsh plugin add dsh-global-todo
```

- 完整中文说明（安装、十张基线图、对比表、开发与发布流程）：[`README.md` 的前半部分](README.md)
- [5 分钟上手](docs/QUICKSTART.md) · [常见问题](docs/FAQ.md) · [设计说明](docs/DESIGN.md) · [数据与备份](docs/QUICKSTART.md#6-数据在哪怎么备份)
- 在线主页（中英切换、22 秒排版演示）：<https://lugabeeee.github.io/dsh-global-todo/>
- 环境要求：Node.js `>= 22.19.0`，DSH `>=0.2.0-rc.1 <0.3.0`（`engines`）
