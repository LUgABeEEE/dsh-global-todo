import { fileURLToPath } from 'node:url'
import { createStore } from '../../lib/store.js'
import { createService } from '../../lib/service.js'

// The demo data is built for whichever checkout runs it; absolute paths in the
// fixtures are resolved here, never written down, so this file is publishable.
const root = fileURLToPath(new URL('../..', import.meta.url))

const file = '/tmp/demo-home/global-todo/todos.json'
const store = createStore({ file })
const service = createService({ store, config: { requireExistingFiles: false } })
const now = Date.now()
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const release = await service.create(
  {
    title: '把 dsh-global-todo 发到 npm，并在 README 里补上截图',
    description: '先把版本号对齐 package.json 与 VERSION，再跑一遍 npm run verify。发布走 Trusted Publishing。',
    steps: [
      { text: '对齐 package.json 与 VERSION', done: true },
      { text: '跑 npm run verify', done: true },
      { text: '打 tag 并推送', done: false },
      { text: '补 README 截图', done: false },
    ],
    evidence: '「这个版本今天发，截图一起补上」',
    tags: ['发布', '文档'],
    priority: 'high',
    dueAt: new Date(now + 20 * HOUR).toISOString(),
    links: ['https://github.com/LUgABeEEE/dsh-global-todo', root + 'docs/QUICKSTART.md'],
  },
  { by: 'human' },
)

const dispatch = await service.create(
  {
    title: '给插件补上「本周 Agent 报告」',
    description: '从完成记录里聚合：谁完成的、触及哪些文件、还有多少待确认。',
    steps: [{ text: '读完成记录的字段', done: false }, { text: '写 /report 路由', done: false }, { text: '面板加一张卡', done: false }],
    tags: ['插件', '功能'],
    priority: 'high',
  },
  { by: 'human' },
)

const reviewed = await service.create(
  {
    title: '清理源文件里仍明文的 ARK 凭据，并核实两个 key 是否为同一把',
    description: '备份已按确认码抹除，但源文件未动。',
    steps: [{ text: 'grep 全仓库', done: true }, { text: '与备份比对', done: true }],
    tags: ['安全', '清理'],
    priority: 'urgent',
  },
  { by: 'human' },
)
await service.complete(
  reviewed.id,
  {
    summary: '已确认两处是同一把 key，源文件已改为从环境变量读取',
    artifacts: [root + 'lib/index.js'],
    sessionId: 'demo-session-1',
  },
  { by: 'agent' },
)

const inbox = await service.create(
  {
    title: '把周报模板换成新的四段式',
    description: '来自一封邮件的外部写入，置信度低于阈值，先进收件箱。',
    tags: ['inbox', '周报'],
  },
  { by: 'agent' },
)

const doneOne = await service.create(
  { title: '手记：等交换机到货再测 2.5G', tags: ['硬件'], priority: 'low' },
  { by: 'human' },
)
await service.complete(doneOne.id, { summary: '已到货并完成第一次联通测试' }, { by: 'human' })

await service.note(dispatch.id, '路由先做出来，卡片可以下一轮。', { by: 'agent' })
await wait(10)
console.log(JSON.stringify({ release: release.id, dispatch: dispatch.id, reviewed: reviewed.id, inbox: inbox.id }))
