**English** · [中文](https://github.com/LUgABeEEE/dsh-global-todo/blob/main/README.md)

[![npm](https://img.shields.io/npm/v/dsh-global-todo?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-global-todo)
[![listed on dsh.works](https://img.shields.io/badge/listed_on-dsh.works-00c2e9?labelColor=0d0d0d)](https://dsh.works/awesome-dsh-plugins/)
[![dsh-xray capability card](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2FLUgABeEEE__dsh-global-todo.json)](https://unstone.github.io/dsh-xray/p/LUgABeEEE__dsh-global-todo.html)

# dsh-global-todo

<img src="docs/icon.svg" width="52" height="52" alt="全局待办 icon: a list card with a check and an arrow leaving it">

**A cross-session todo list for DeepSeek Harness: one file you own, written by you and your
agent, and handed to a conversation in one click.**

Three things it does that a session-local plan cannot — the first is the one it is known for:

1. **An agent saying "done" is a claim, whichever door it comes through.** Its own report — the
   tool call, a status change — and the host closing the todo after a clean turn are both just
   claims: the record waits in **待确认 / Needs review** until a person confirms it, or sends it
   back with its completion cleared. A session-local plan never asks that question: the agent
   rewrites the table and the work is "finished".
2. **One JSON file is the whole list.** `cat`, diff, commit it, put it on a NAS, carry it to
   another machine. Nothing lives inside a session log.
3. **Hand-off is a button, not a paragraph.** Four modes, the working directory checked, and
   the todo's own **steps** arrive as a numbered plan.

![The panel in use: list, detail, steps, review, inbox, reminders, selection](docs/screenshots/tour.gif)

```sh
dsh plugin add dsh-global-todo
```

[Live page](https://lugabeeee.github.io/dsh-global-todo/) (22-second typographic demo) · [中文](https://github.com/LUgABeEEE/dsh-global-todo/blob/main/README.md#zh) · [5-minute quickstart](docs/QUICKSTART.md) · [FAQ](docs/FAQ.md) · [Every state has a baseline image](#screenshots) · [Design notes](docs/DESIGN.md)

---

## Why another todo plugin

DSH's built-in `todo_write` belongs to one agent session: whole-list replacement, three
states, and a plan that disappears when the session does. The community plugins that fix
that split into two camps — the ones that dispatch work to agents (auto-resume, bound
sessions) and the ones that accept real document attachments. This plugin does both, on
one record:

| | built-in `todo_write` | dsh-global-todo |
|---|---|---|
| Owner | one agent session | **you** — across sessions and workspaces |
| Writing | whole-list replacement | per-field, human **and** agent |
| When it was added | not tracked | **`createdAt`, immutable, shown everywhere** |
| Context | title + state | description + **documents and addresses** |
| Hand-off | — | **one click: reuse the bound conversation or open a session** |
| Finishing | whatever the agent writes | **waits in Needs review for a person** |
| Storage | session event log | one JSON file you can `cat`, edit, diff and back up |

## Confirmation: no record finishes itself

This is the rule the plugin is known for, and the one that separates it from every list that lets
the agent report its own progress: **an agent's "done" is a sentence it said.** The record is
written as `done` and carries `review: { pending: true }`; the row shows a **Needs review** badge
and the header a chip with the count, until a person answers.

Both doors are gated, because both are only a claim:

| Where "done" came from | The record | Who answers |
|---|---|---|
| the agent's `global_todo_done`, or a status change to `done` | `done` **+ pending review** | a person |
| the dispatched conversation ended cleanly, so the host closed it (`turn/end` = `completed`) | `done` **+ pending review** | a person |
| you clicked done in the panel | `done` | already a person |

- **Two answers.** *Confirm done* drops the mark and records who confirmed it; *Send back* returns
  the todo to `open`, clears `doneAt` and the completion record, and adds a `reopened` entry.
  Nothing is deleted: title, description, steps, attachments and notes all stay.
- **The automatic close goes through the same gate.** What the host writes on the agent's behalf is
  thinner than what the agent could have written — only the closing message and the files that turn
  changed — so it has even less business counting by itself.
- **Only clean turns are candidates.** `error`, `aborted`, `interrupted` and `max-tokens` leave the
  todo open. A failed job wearing a "done" label is the one failure mode that would make the whole
  list untrustworthy.

There is exactly one implementation of the rule: `completeTodo`, `applyPatch` and a status change in
`lib/model.js` share the same `by === 'agent'` test, and the panel and the eleven tools all go through
it.

## What 0.9 and 0.10 added (and the two just before)

Five surfaces these READMEs had never explained. Session read-back and evidence came in 0.9;
Markdown and the weekly report in 0.10; steps in 0.8. Each changes what a record can carry, or what
you can do with it after the fact. (The review mark came in 0.7 and now opens this document, instead
of hiding among the new features.)

### Steps: a plan inside the todo

A todo can carry up to 20 steps of 200 characters (`LIMITS` in `lib/model.js`). A step is
`{ text, done }` — a line inside one unit of work, not a subtask with its own id and status.

- **Add them** in "More fields" → Steps, one per line.
- **Tick them** in the detail panel; the row shows `steps 2/5`.
- **Hand off** and the dispatch prompt numbers them, prefixing finished ones with `[已完成]`.
- **Export** and Markdown writes them as nested `- [ ]` lines; import reads them back.

### Evidence: the sentence it came from

`evidence` is the sentence a captured todo came from, quoted verbatim, up to 300 characters.
`global_todo_capture` asks the model for it, `global_todo_add` accepts it, and the detail panel
shows it as a blockquote under **In the author's words**. A todo you typed yourself has none.

The field exists for one reason: a capture without its source reads as an opinion later. It is
also in the Markdown export (`原话:`).

### Session read-back

A hand-off starts work in another conversation, so the detail panel answers "what did it say"
without switching away. `GET /api/global-todo/session?id=` returns `alive`, `dir` and a `tail`
of the last assistant message; the panel shows **Session read-back** with running / dormant, the
last sentence, and a button that opens that conversation.

The tail is bounded and in memory: 200 conversations, 400 characters each, filled from every
`assistant/message`. Nothing is written to disk, so a Host restart forgets it. A missing tail is
normal — this process has not seen that conversation speak.

### Markdown in and out

The JSON export is the round-trip format. Markdown is the one you read, diff and edit by hand
(note that `doing` and `cancelled` come back as `open`: a hand-edited list has no work-in-progress
state, and the JSON remains the format that round-trips exactly):

```text
- [ ] 标题
      优先级: 高 · 截止: 2026-10-21T18:00 · 标签: 发布, 文档
      原话: …
      描述: 第一行
      - [x] 一步
```

| Direction | Where | Behaviour |
|---|---|---|
| Out | **More actions → Export Markdown**, or `GET /export?format=md` | Grouped 未完成 / 已完成 / 已归档; metadata indented under each task |
| In | **More actions → Import** (a `.md` file), or `POST /import { markdown }` | Creates new todos through `create`; Markdown has no ids, so it never overwrites an existing record |

Tolerant by design: unknown lines are ignored, an unparseable date is dropped, and a file with no
`- [ ]` line is refused with a reason. Field labels are Chinese (`优先级 / 截止 / 标签 / 原话 /
描述 / 附件 / #`), and import reads the same set.

### Weekly report

**More actions → This week** (`GET /report?days=7`) answers "what moved, and did any of it land
in code". Everything is derived from completion records; nothing is stored.

| Field | Meaning |
|---|---|
| `finished` | completions in the window, newest first, with the actor and the summary |
| `sessions` | distinct conversations those completions came from |
| `created` | todos added in the window |
| `pendingReview` | done items still waiting for an answer |
| `files` | file artifacts touched, most frequent first — 12 listed, `fileCount` total |

`days` above 90 is clamped to 90; a missing or non-positive value falls back to 7.

## Screenshots

![The panel: count chips, grouped list, urgent rows marked](docs/screenshots/panel.png)

![One row opened: inline editing, attachments with 打开 / 复制路径, activity](docs/screenshots/panel-detail.png)

![Settings: grouped fields, hints under each label, one save row](docs/screenshots/panel-settings.png)

![Phone width 390×844: 44px touch targets, side-scrolling filters, icon-only row actions](docs/screenshots/mobile/panel.png)

Every state that only appears under a condition has a fixed baseline image, rendered by the same
preview and photographed by the same tool:

| State | Image |
|---|---|
| Empty list | [`panel-empty.png`](docs/screenshots/panel-empty.png) |
| Filter with no match | [`panel-filtered.png`](docs/screenshots/panel-filtered.png) |
| Inbox (awaiting confirmation) | [`panel-inbox.png`](docs/screenshots/panel-inbox.png) |
| Awaiting review (agent finished) | [`panel-review.png`](docs/screenshots/panel-review.png) |
| Due reminder | [`panel-reminders.png`](docs/screenshots/panel-reminders.png) |
| Selection mode | [`panel-select.png`](docs/screenshots/panel-select.png) |

These are produced by `npm run screenshots` (which chains `npm run preview`): the real client
half is rendered to static HTML with no Host and no dependencies, then photographed at 1280×720
into `docs/screenshots/`. Playwright is not a dependency — the tool borrows the copy a DSH
profile already installed, or whatever `DSH_PLAYWRIGHT` points at.

The phone set is photographed by the same tool: `npm run screenshots:mobile` renders the same
component tree at **390×844** first — the harness answers the panel's width measurement with 390,
so the narrow branch really runs instead of the desktop layout being scaled down — and writes into
`docs/screenshots/mobile/`.

What each file shows, and when it is regenerated, is indexed in
[docs/screenshots/README.md](docs/screenshots/README.md).

## Requirements

- DeepSeek Harness `0.2.x` (developed and verified against `0.2.1-rc.2`; the `0.2.1-rc.3` changes
  were checked item by item — its new sidebar **More** menu does not touch how this plugin registers
  its entry; `engines.dsh` is `>=0.2.0-rc.1 <0.3.0`, and a Host outside it skips the bundle instead
  of warning)
- Node.js `>= 22.19.0` (the Web profile's own requirement)
- A **Web** client: the panel is served by the Host's web server. Headless / ACP / SDK keep the
  agent tools but have no panel; an Electron-style desktop client (file:// + IPC) is not
  supported yet
- After a Host upgrade, refresh the page — the client module graph belongs to the release the
  page booted with
- No runtime dependencies. Nothing is imported from `@deepseek-ai/*`.

## Install

**Check your profile name first.** The plugin is installed into one profile, not into the
machine; a wrong profile name still exits 0, and then nothing shows up in the sidebar after a
restart — the most common first-run trap.

```sh
ls ~/.dsh/profiles          # Windows: dir %USERPROFILE%\.dsh\profiles
```

Replace `<profile>` below with one of the names that command prints (`web` on most hosts;
use your desktop or `headless` profile name if that is what you run):

```sh
# from npm
dsh plugin --profile <profile> add dsh-global-todo

# or from a checkout, which is also the development path
dsh plugin --profile <profile> add /absolute/path/to/dsh-global-todo
```

The plugin is a Loader row, not a hot-loaded script: **restart the host** (`dsh web`, or
whatever start command you use) after installing, then refresh the page. A "待办 / Todos"
entry appears in the sidebar.

> Sidebar still empty? Check three things in order: ① which profiles `ls` actually printed and
> whether the one you installed into is the one running; ② whether the host really restarted
> (the Loader is read once at boot); ③ whether the page was refreshed (the client module graph
> belongs to the release the page booted with).

The npm package is the source of truth. A community catalog can lag behind it or point at an
older release; pin the version you want (`dsh plugin --profile <profile> add dsh-global-todo@0.13.1`)
when it matters.

### Installing from DSH's Discover tab

DSH's Discover tab reads a plugin market index from a URL you add yourself — dsh ships none, and
a user-added index is the one path that installs without copying a command. This repository
publishes one:

```text
https://lugabeeee.github.io/dsh-global-todo/market/index.json
```

It is generated from npm by `npm run market` (`docs/market/index.json`) and validated against
dsh's own `@deepseek-ai/dsh-plugin-market-index` before it is written. `npm test` fails when its
newest version is not the version in `package.json`, so a release that forgets to regenerate it
is caught before it ships.

**Hand-copied a directory instead?** Check it before wondering why the plugins page looks wrong:

```sh
npx dsh-global-todo-doctor "$HOME/.dsh/plugins-local/全局待办插件"
```

It verifies the manifest, the patch file, both entries, `locale/`, the icon and `lib/`, and exits
non-zero when something required is missing — the `locale/` case is the field failure that makes
the desktop app print `Plugin metadata … ENOENT … \locale` while the plugin still loads.

To roll back:

```sh
dsh plugin --profile <profile> remove dsh-global-todo
```

Your list is not touched by install or uninstall: it lives outside the plugin, at
`$DSH_HOME/global-todo/todos.json`.

## Using it

### The panel

- **Add** — type a title and press Enter. "More fields" reveals the description, the
  attachment box (one document path or URL per line), tags, priority and a due time. An
  attachment may also be `{ kind: "image", value: "/abs/shot.png" }` — the row then shows a
  thumbnail and the detail a preview, with the bytes read on demand (png/jpg/jpeg/webp/gif/avif,
  ≤8 MB) and never copied into the list.
- **Filters** — all / open / doing / done / overdue, plus a text search across titles,
  descriptions, tags and attachments. The count chips in the header are filters too.
- **Grouped by urgency** — overdue / today / next up / later / no due date / done, each
  collapsible, because "what is late" is the first question a list has to answer.
- **Rows** — show `added <time> (<age>)` with the exact timestamp on hover, the priority,
  the due time, the tags, the attachment count, and which side created the entry.
- **Details** — edit title, description, priority and due time inline; attach or detach
  documents and addresses (with 打开 / 复制路径 on each); read the activity trail.
- **Undo a delete** — deleting keeps the record for eight seconds and offers 撤销, which
  restores it verbatim: same id, same creation time, same attachments.
- **Keyboard** — `/` focuses search, `n` focuses the new-todo field while the add form is
  open, `Esc` collapses the open detail. Row actions appear on hover or keyboard focus.
- **Phone / narrow screens** — the panel switches on its own **measured width**: at 600px or
  less it becomes a touch layout (fold gesture, 66px rows, 44px targets, safe areas). Details,
  thresholds and measured sizes are in the “On a phone” section below.
- **Reachable from the LAN and from a tunnel** — the routes defer to the Host's connection fence
  (which honours `--trusted-host`); the plugin's own loopback check is only the fallback for a
  Host without that service. `/health` reports `fence` so you can see which one is in force.
- **Auto-collect (off by default)** — a panel switch. When on, a conversation you are in that
  finishes a clean turn is asked once whether anything needs following up, but only once it has
  been quiet for 30 minutes, and only if you are actually in that conversation (never a dispatch
  target, a subagent or a background run). Aborted and failed turns are skipped. The question is
  itself a message in the conversation, so it restarts the quiet clock — which is why **only a
  message you wrote arms it again**: one question per turn from you, and it can never chase its own
  answer. The switch is Host state, so it survives the panel being closed and is reported by
  `/health`. Each conversation's group also carries an **`Exempt`** button: it takes that
  conversation's whole **working directory** out of automatic collect (click again to undo). That
  is for conversations a machine drives — a chat companion's room — whose session is recreated with
  a new id when it restarts, so the exemption is keyed on the directory rather than on one
  conversation and cannot quietly stop applying.
- **Collect per conversation** — the `Collect` action sits on each conversation's group header in
  the list, asks *that* conversation to record what needs following up, and the items land under
  it. The toolbar keeps a "collect from this chat" fallback, shown only when the current
  conversation has no group yet. A conversation that is not running is resumed first, like a
  hand-off.
- **Batch assignment** — switch on `选择`, tick a few todos, and one click sends each one to the
  conversation that wrote it, else to a same-workspace conversation, else to a target you pick.
  That is an attempt order: an unloadable target means the next one is tried. Anything with
  nowhere to go comes back with a picker rather than being sent somewhere unchosen, and one
  failure does not abort the batch.
- **Search syntax** — `tag:release` (or `#ops`), `is:overdue`, `is:active`, `has:link`, `before:2026-11-01` / `after:2026-10-01` (deadline bounds; a half-typed date simply stops filtering),
  `has:note`, `level:p0`, plus free words combined with AND (which also match note text). A
  search without a colon behaves exactly as it always did.
- **Progress notes** — an append-only trail per todo (count on the row, full text and an add
  box in the detail). An agent reporting a blocker writes here instead of rewriting your
  description, and writing one makes automatic completion stand down.
- **Dead attachments are flagged** — a file link whose target is gone is marked on the row and
  labelled in the detail. Computed on read, never stored.
- **Where a new conversation goes** — a hand-off that opens one joins the workspace owning
  the conversation that wrote the todo (and starts in that workspace's directory), so
  "continue this work" does not land beside unrelated sessions. The picker also lists the
  workspaces (`＋ new conversation · <workspace>`), and a named workspace wins over the
  inherited one. The working directory only decides when neither is known.
- **The picker lists what you actually use, newest first, without archived conversations.** The
  order is the sidebar's recency key (`updatedAt`). Conversations sharing a title get a short id
  suffix, and a target that is no longer listed (archived since it was chosen) is shown as
  `(archived)` instead of appearing as a different conversation.
- **You pick the target** — the toolbar shows `交给：[ conversation ▾ ]`, listing your
  conversations: whichever you choose is sent with `authoritative: true` and the Host honours
  it verbatim, with no inference on top. The list marks the conversation the Host would have
  chosen on its own, `自动` restores that behaviour, and `＋ a new conversation` starts a fresh
  context. A choice is remembered, and changing it is one click in the same control — what you
  see is what happens.
- **A receipt for every hand-off** — the panel says which conversation received the work and
  offers to open it. A dispatch starts work *elsewhere*, so staying silent looked exactly
  like "nothing happened".
- **Hand to agent** — the panel says **where it will go** before you press it, and the
  default is `current`: the conversation **you** last wrote in (read from the session log,
  keeping only `source.kind === 'user'` messages — the plugin's own injected hand-off
  messages are excluded, or each dispatch would drag the next one to its own target; the id
  is also kept next to the data so a restart does not forget it). `auto` prefers the
  conversation this todo already owns, then the current one, and only then opens a fresh
  session; `new` always opens one; `bound` insists on the bound conversation and says why
  if it is gone. When nothing usable can be resolved the hand-off **fails with a reason**
  instead of quietly opening another conversation.
- **Grouping** — the toolbar offers `workspace / time / priority` and defaults to
  **workspace**: everything written in one directory collapses into a single entry that says how
  many it holds, headed by that directory's name (the full path is the tooltip), so a few
  「抓一下待办」 runs do not turn the list into a wall of rows. An item with neither an origin
  directory nor a bound conversation (added in the panel) sits under 手动添加. `time` is the
  original overdue / today / soon / later / no-due buckets, `priority` groups by level.
- **Levels P0–P3** — `P0 urgent / P1 high / P2 normal (default) / P3 low`; the API accepts
  either the canonical names or the labels (`priority: "P0"` works), with a badge on the
  row. Records written before levels existed keep their `high/normal/low`, so nothing needed a
  migration. A conversation group shows the highest level it holds, and a green dot marks a
  group with a conversation still running.
- **Collect from this chat** — one button injects "record what this conversation needs to
  follow up, with `global_todo_capture`" into the conversation you are in, so a chat turns
  into todos without typing them out. The prompt states what *not* to record as well
  (session plans, small talk, finished work) — a capture instruction without that ceiling
  only produces noise.
- **Automatic completion** — when a handed-off session closes its turn **cleanly**, the Host
  finishes the todo itself: the agent's closing message becomes the summary and the files
  that turn touched become the artifacts. No waiting for the model to remember a tool call.
  A finished row shows 完成于 … plus artifact chips, and its detail carries a completion
  section you can open or copy paths from. Two guards matter: only a session this plugin
  **just dispatched to** can complete itself (idle chatter in a bound conversation must not
  finish work), and a turn that **failed or was interrupted is never marked done** — an open
  todo is far better than a failed job wearing a "done" label. `global_todo_done` with
  `summary` and `artifacts` remains the primary path; the watcher is the safety net.
- **Working directory** — the toolbar says where a new session will start. It follows the
  conversation you are in by default; 选择 picks one explicitly and remembers it, and
  跟随当前会话 clears that choice. A todo also remembers the directory it was written
  from (taken from the tool call's own context), and that is inherited too. With none of
  the three available, the hand-off is **refused with a reason** — a session without a
  working directory is a session where the agent can do nothing.

### On a phone

Nothing to configure: DSH Mobile puts the panel in its `main` slot, the panel **measures its own
width**, and at 600px or less it becomes a touch layout. Dragging a desktop window narrower than
600px gets the same treatment — the signal is the panel's measured width, not the window's and not
the user agent. Above 601px the desktop page is pixel-identical, and `check:render` asserts that at
601 / 900 / 1280 / 1440.

Measured at 390×844: a 44px header line, a three-row toolbar (filters / search / grouping, 44px
each), the list starting at 287px, and 66px per row — about eight rows on the first screen.

- **The fold is a gesture, not a switch.** Scrolling down past 80px folds the search line away, and
  it has to clear the 110px that line gives back — otherwise the content the reader is looking at
  jumps out from under the thumb. The first upward flick of 48px, or reaching the top, unfolds it.
  Either direction is deaf for 300ms after a flip, so a thumb resting on the boundary does not
  oscillate.
- **A folded row is one title line plus the signals that change what to do next** — deadline,
  priority, review badge, completion time — with the open row kept whole. Attachment chips fade
  instead of vanishing, so the row height stays 66px.
- **The three group modes stay visible**: workspace / time / priority are side-by-side tabs that the
  fold does not touch. “Workspace” groups by the directory the work was written in, headed by the
  directory name.
- **No dead switches on a phone**: the dispatch summary (交给 / 上下文) and the auto-collect switch
  moved into the settings sheet (the desktop keeps them), and 选择 moved after the search field. The
  toolbar is filters, search, grouping — nothing else.
- **Touch and safe areas**: buttons, inputs and filter chips are 44px; chips scroll sideways instead
  of being clipped; the inline hand-off collapses to its icon (the menu and the detail keep the
  words); keyboard hints are gone; the bottom padding yields to the safe area; text follows the
  mobile page's text-size setting, and inputs stay at 16px or more so iOS does not zoom the page.
- **Nothing else changes**: `dsh-mobile`, DSH and the mobile plugin need no configuration, and the
  desktop keeps its layout.

The three 390×844 baselines: [panel](docs/screenshots/mobile/panel.png) ·
[one row open](docs/screenshots/mobile/panel-detail.png) ·
[settings](docs/screenshots/mobile/panel-settings.png).

### Agent tools

| Tool | Purpose |
|---|---|
| `global_todo_add` | Record an item — description, attachments, steps, tags, priority, due time |
| `global_todo_note` | Append a progress note — where you are, what blocks you, who must decide |
| `global_todo_capture` | **Record a batch**: for 「抓一下待办」 or a turn that produced several follow-ups; each entry is validated on its own, and entries scoring below `captureMinWeight` are reported as skipped with their weight instead of being registered |
| `global_todo_list` | Query by state, tag or text; every row carries its creation time |
| `global_todo_get` | Read one item in full, including attachments and the last hand-off |
| `global_todo_update` | Change any field of one item, including `status` (`archived` archives without deleting); `""` clears, `[]` empties |
| `global_todo_link` | Attach or detach documents and addresses |
| `global_todo_done` | Mark done, back to open, or in progress |
| `global_todo_reopen` | Put a **wrongly finished** item back (`done` / `cancelled` → `open`); refuses anything else, and the trail records it as the agent |
| `global_todo_remove` | Delete permanently (done items should be marked, not deleted); the removal leaves a tombstone, so the other machine cannot bring it back |
| `global_todo_sync` | Fold the list with the copy in the shared directory (needs the panel's Shared directory, or a deployment `sync.dir`); `dryRun` computes without writing |

### Live check

The test suite uses doubles; `npm run check:live` checks the **wired** Host instead —
the routes the panel actually calls, the list it actually reads, and a record that survives
delete-then-undo. It creates a temporary record, compares every field after the round trip
(id, creation time, attachments, tags, level, due time, description), asserts that bound
records carry `sessionAlive`/`sessionDir`, and removes its temporary record even when it
fails. It needs a running Host, so it is not part of `verify`.

### Proactive capture

A guidance section is injected into the system prompt (turn it off with `guidance: false`).
It states both sides of the policy, because a prompt that only says "remember things"
produces noise, and a noisy list is worse than an empty one:

- **record on your own initiative** when the user mentions something that needs following
  up across sessions (waiting on a reply, due next week, a decision pending, a promise),
  when a turn ends with a step that should not continue in that session, or when the user
  says 「记一下 / 别忘了 / 回头办」;
- **do not record** what you can finish in this step, the session's own plan, or small talk;
- say in **one line** what you recorded — do not restate the description;
- say **「抓一下待办」** and the agent scans the recent conversation, records the batch with
  `global_todo_capture` and answers with a summary.

The boundary: it **records, it never starts work**. The list belongs to the human, and
starting a task stays a human decision (see the non-goals in [ROADMAP](docs/ROADMAP.md)).

Capture is not allowed to become noise. Before an item is written, the same normalized title
(full-width, case, spacing and punctuation folded away), a close paraphrase within the last 72
hours (Dice similarity over character bigrams, 0.8), and the same errand finished in the last 7
days are all refused with a reason on the record; archived and cancelled rows do not block a
new one. The rules live in `lib/capture.js` and are tested on their own.

### Dividing the work with a memory plugin (dsh-mnemon)

When dsh-mnemon is installed, the plugin injects **one extra section** — and only when it can see
the memory plugin. Two plugins that both say "remember this" tend to store the same sentence twice:
once as an action, once as a fact.

| Where it belongs | What it is |
|---|---|
| **the list** (`global_todo_*`) | an **action** to follow up: a reply, a deadline, a promise |
| **memory** (`mnemon_remember` / `mnemon_recall`) | a **fact** already known: a decision, a preference, a conclusion, a trap |

- A completion gains one line: "if the conclusion is worth keeping, `mnemon_remember` it with the
  todo id in the body".
- Reading "there is still something to do" out of memory means **adding a todo** — memory items are
  never ticked off.
- Without a memory plugin neither the section nor the line exists: a tool that is not there must not
  be named.

Two places implement it: `memoryGuidanceFor()` (`lib/index.js`, its own section, registered only
when `ctx.inject(['systemPrompt','mnemonMemory'])` fires) and `createTools({ hasMemory })`
(`lib/tools.js`, the line in the tool result).

### Two machines, one list

When the same list has to be visible on a workstation and a laptop, the plugin does **not** share
a file: each machine keeps its own, and they meet in the middle. Pointing `storePath` at a NAS makes
every panel read a network round trip, and an offline machine cannot open its own list at all.

On **each machine**, open the panel's Settings → Multi-machine sync and enter the **same absolute
path**:

| Field | Value (example) |
|---|---|
| Shared directory (Linux / macOS) | `/mnt/nas/agent-rw/global-todo` |
| Shared directory (Windows) | `Z:\Agent产出\global-todo` (a mapped drive or a UNC path) |
| Auto-sync interval | 5 minutes by default; **0 = only when asked** (the panel button or the tool) |

The values land in `settings.json` as `syncDir` / `syncMinutes`. A headless deployment can set a
default as `config.sync.dir` in the plugin patch; the panel wins once it has a value:

```yaml
# the profile's cordis.patch.yml (`config` is replaced wholesale — restate what you keep)
- id: global-todo
  config:
    sync:
      dir: /mnt/nas/agent-rw/global-todo
      intervalMinutes: 5
```

Once both point at the same directory, a **`todos.hub.json`** appears there (with its `.lock`).
One sync = read local + read hub → fold → write the hub back (locked, re-merged under the lock) →
write the fold back to local. The fold has three rules:

| Situation | Result |
|---|---|
| Two machines changed **different** todos | both survive |
| Two machines changed **the same** todo | the later `updatedAt` wins; only a millisecond tie compares content, and both sides order it the same way |
| One deleted, the other only holds **an old copy** | the deletion wins. Every removal leaves a tombstone (the document's `trash`), and undo removes the tombstone with the record |
| Both were **offline and created** something | `seq` is numbered from the set of records: the earlier creation keeps its number, the other is renumbered by creation order — the same on both machines |

- **Triggers**: about 10 s after start, then a one-minute ticker that compares the interval (the
  panel's value — changing it needs no restart); also the panel's Sync now, `POST
  /api/global-todo/sync`, or the agent calling `global_todo_sync` (`{ "dryRun": true }` writes nothing).
- **Reading the list always reads the local file.** A slow, disconnected or unmounted share never
  blocks the panel or the tools; `/health.sync` reports the last attempt and why it failed.
- **The plugin will not invent the share.** If the parent directory is missing it answers
  `sync-unavailable` (503) instead of creating an empty local directory — which would leave both
  machines writing happily and looking healthy while syncing nothing.
- **The hub write is locked and re-merged**: two machines syncing in the same second cannot erase
  each other's arrivals.
- **An idle sync writes nothing** (no mtime churn, no waking the sync client).

**Every machine has to be on 0.21.0 or newer.** An older build refuses a document with `trash` on the
grounds of a newer schema — deliberately: silently dropping tombstones is how a deletion comes back,
and that looks like "delete is broken".

**What it cannot do** (stated here rather than discovered later):

- merge two **field-level** edits inside one record (a tag added on A, a priority changed on B — only
  the later one survives);
- keep a tombstone longer than a year (`TOMBSTONE_TTL_MS`); a machine offline for longer is treated
  as holding real data;
- trust the clocks: `updatedAt` is each machine's wall clock, so a fast clock wins more often;
- carry attachment **bytes**: an attachment is a path, and it has to be reachable on both machines.

### HTTP API

The panel talks to the host over these routes. They are fenced by the host connection
fence when that service is present, and by a strict loopback check otherwise.

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/global-todo/list` | `status`, `query`, `tag`, `sort`, `limit` — the reply carries `matched` and `truncated` when the page was cut |
| GET | `/api/global-todo/dirs` | `path?` — list subdirectories for the panel's built-in folder picker (the shell's own picker is preferred when mounted) |
| GET | `/api/global-todo/get` | `id` |
| GET | `/api/global-todo/export` | — (the store's own JSON document; `?format=md` gives a Markdown task list) |
| POST | `/api/global-todo/import` | `{ doc, mode?: replace\|merge, dryRun? }` — `replace` is an exact round trip, `merge` folds by record (later `updatedAt` wins, deletions travel as tombstones; what the panel sends); `dryRun` returns `wouldCreate` / `wouldUpdate` and writes nothing |
| POST | `/api/global-todo/reminders/ack` | `{ ids }` — stop listing these passed deadlines as due |
| POST | `/api/global-todo/note` | `{ id, text }` — append a progress note |
| POST | `/api/global-todo/capture` | `{ sessionId? }` — ask the current conversation to collect its follow-ups |
| POST | `/api/global-todo/bulk` | `{ ids, status?, addTags?, removeTags? }` — one change across a selection; a stale id lands in `unmatched` instead of failing the batch |
| POST | `/api/global-todo/ingest` | `{ items: [{ title, source: { kind }, confidence }], dryRun? }` with `Authorization: Bearer <settings.ingestToken>` — external items; below `ingestConfirmBelow` they wait in the inbox |
| GET | `/api/global-todo/health` | — (store location, counts, dispatch capabilities, plus **tool registration** and **whether the completion watcher attached** — both fail quietly, so both are reported — and `metrics`: dispatch success rate, agent tool calls, list growth; `autoCollect`: why each waiting conversation was or was not asked, counters, and how the settings file loaded; `version` is the running module and `packageVersion`/`stale` say whether the installed package is newer than the running one; `review.items` names the finished todos that still wait for a person, so a check does not have to drive the panel) |
| POST | `/api/global-todo/create` | `{ title, description?, links?, steps?, tags?, priority?, dueAt? }` |
| POST | `/api/global-todo/update` | `{ id, ...fields, by?: human\|agent }` |
| POST | `/api/global-todo/status` | `{ id, status, by?: human\|agent }` |
| POST | `/api/global-todo/remove` | `{ id }` |
| POST | `/api/global-todo/restore` | `{ todo }` — put a removed record back verbatim (undo) |
| POST | `/api/global-todo/review` | `{ id, decision: confirm\|reject }` — answer an agent's completion |
| GET | `/api/global-todo/report?days=7` | what the agents finished in the window, and the files it touched |
| GET | `/api/global-todo/session?id=` | what a bound conversation last said (`tail`, `alive`, `dir`) |
| POST | `/api/global-todo/relink` | `{ id, index, value }` — re-point a dead attachment (the value must still be a valid absolute path or URL of that kind) |
| GET | `/api/global-todo/asset?id=&index=` | the bytes of an **image** attachment (path read from the store, never from the request; ≤8 MB, png/jpg/jpeg/webp/gif/avif) |
| POST | `/api/global-todo/link` | `{ id, add?: [...], remove?: [value \| index] }` |
| POST | `/api/global-todo/dispatch` | `{ id, mode?: auto\|bound\|new\|current, sessionId?, dir? }` |
| POST | `/api/global-todo/assign` | `{ ids, items?, target?, dir? }` — hand several todos over in one call; an id that matches nothing comes back instead of being sent elsewhere |
| POST | `/api/global-todo/settings` | `{ autoCollect?, idleMinutes?, cooldownMinutes?, exemptWorkspaces?, captureMinWeight? }` — the Host-side switches behind automatic collect; `captureMinWeight` (0–1, default 0.35) is the floor below which a batch-capture candidate is reported as skipped instead of registered |
| POST | `/api/global-todo/diagnostics` | `{ scope, status?, reason?, message?, url? }` — the panel's own error report |
| GET | `/api/global-todo/sync` | — (`configured`, `dir`, `last`, `error`: what the multi-machine sync is doing) |
| POST | `/api/global-todo/sync` | `{ dryRun? }` — fold now and write both sides; `sync-not-configured` when no share is set |

`by` on `/update` and `/status` says whose write this is: omitted (what the panel sends) it is
the person at the keyboard, and a script acting for the agent says `by: 'agent'` rather than
being filed as a human. Anything else is a `400` — a provenance field that silently absorbs a
typo is worse than no field at all.

Errors are typed: `400` for a rejected value, `404` for an unknown id, `413` for an
oversized body, `403` for a request that fails the fence, `502` when a hand-off cannot
reach the agents service. The body is always `{ ok, ... }` with a machine `reason`.

## Where it is listed

npm is the only install source; every registry below is a discovery surface. Verified 2026-10-26 —
re-check with `node tools/listings.mjs` rather than trusting this list.

Two of the three badges at the top are the registries' own, not ours. dsh.works publishes a static
badge for plugins in its registry; the dsh-xray one is a live endpoint reading their daily scan, so
it changes on its own and links to a capability card that cites a file and line for every finding.
The third reports the npm version and nothing else.

| Registry | Form | State |
|---|---|---|
| [npm](https://www.npmjs.com/package/dsh-global-todo) | the package | `0.19.0` |
| [dsh.works](https://dsh.works/awesome-dsh-plugins/) | machine-readable index, rebuilt daily (21,928 rows) | listed, tracking `0.19.0` |
| [dsh-xray](https://unstone.github.io/dsh-xray/p/LUgABeEEE__dsh-global-todo.html) | capability card + embeddable badge | rated `C2`. It read `C3` because one `!` entry in `files` defeated their allowlist for the whole package ([#7](https://github.com/unStone/dsh-xray/issues/7)); they switched to `npm-packlist` and rescanned ([#9](https://github.com/unStone/dsh-xray/pull/9)), and we stopped using negations in our own `files`. The `exec_tooling` / `eval_tooling` findings stay on the card as non-scoring evidence |
| [1024 Store](https://deepseek1024.com) | catalog entry ([PR #654](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/654), merged) | tracks `0.19.0`; its install line is still the `not_checked` GitHub source — their repository inspection has been down since 2026-09-07 ([#19](https://github.com/imsai-sh/dsh-1024store/issues/19)) |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (19.7k★) | one YAML per plugin | merged ([PR #7498](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7498)) |
| [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) (469★) | a `MARKET.md` row | listed, row 656 |
| [dsh-plugin.shop](https://www.dsh-plugin.shop/) ([22★](https://github.com/losebird/dsh-plugin-market)) | curated JSON entry ([PR #49](https://github.com/losebird/dsh-plugin-market/pull/49), merged) | its install line is the npm spec, not the GitHub source — this is the entry that replaced the auto one pinned to `v0.6.6` |
| [dsh.pub](https://dsh.pub/en/plugins/dsh-global-todo/) | published page + `dshpub` CLI | live, install pinned to a commit |
| [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) | `registry.json`, collected from the `dsh-plugin` topic | `v0.19.0`, risk tier `safe` |
| [walkinglabs](https://github.com/walkinglabs/awesome-deepseek-harness-plugins) | source-verified README | merged ([PR #114](https://github.com/walkinglabs/awesome-deepseek-harness-plugins/pull/114)) |
| [Blue-Whale](https://leenkcool.github.io/plugins.zh.html) | site index + `repos.txt` | listed (category `tools`) |
| [deepseekserver.com](https://deepseekserver.com/resources/dsh-global-todo) | a resources page in each language | live, snapshot is old (still says ⭐3) |

Five more are in review (Zhiyuan-Fan, kejixiaoliang, beancookie, losebird, plus an update PR for the
1024 catalog, [#662](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/662)), and one
maintainer promised to include it (dshopen.org). The full table, including the auto-collected topic
feeds we have not verified, is [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## Where the data lives

`$DSH_HOME/global-todo/todos.json`, or any absolute path you set:

```yaml
# the profile's cordis.patch.yml
- id: global-todo
  config:
    storePath: /home/me/notes/global-todos.json   # a synced or versioned folder
    dispatchDir: /home/me/projects/thing          # default cwd for a new session
    requireExistingFiles: true                    # refuse a document that is not there yet
    toolGroups: all                               # all (11 tools) | core (6: the list itself) | none
    sync:
      dir: /mnt/nas/agent-rw/global-todo           # the directory two machines meet in; empty = on its own
      intervalMinutes: 5                           # how often to fold
```

The file is the artifact: plain JSON, one record per todo, written through a temp file and
`rename()`. Inside one process the human's and the agent's edits share one serial chain; **across
processes** a lock file does the same job: a mutation creates `todos.json.lock` exclusively first,
so a second Host process (the Web panel plus a desktop or CLI session, or two machines sharing a
synced folder) queues behind it and hears `store-busy` (503) after five seconds instead of quietly
erasing the other change. A damaged file is reported (`store-corrupt`) rather than silently reset,
and a single mangled record is skipped instead of taking the list down. Back it up by copying it —
and check that no `.lock` file is left behind, which normally means somebody died mid-write.

The document also carries `trash`: every removal leaves a tombstone `{ id, at, by }`, kept for a year
and capped at 5000 entries (`TOMBSTONE_TTL_MS` / `TOMBSTONE_LIMIT` in `lib/replica.js`). **Without it,
a deletion never reaches the other machine** — its older copy puts the record straight back. You can
clear them, and that is the same decision as giving up on deletions propagating.

The same directory also holds `settings.json` (host-side switches) and `client-errors.log` (panel
errors, capped); **only `todos.json` is worth backing up**. A `.lock` that never goes away, with
writes answering `store-busy`, means a process is holding it — check for a second host on the same
`storePath` first, then follow [FAQ 9](docs/FAQ.md).

## Design decisions

**Attachments are references, not uploads.** A document is an absolute path that stays
where it is; an address is a URL. Nothing is copied into plugin storage, so a document
stays editable and diffable, the list stays small, and a dispatched agent opens the very
same path with its own tools. URLs carrying credentials are refused, because the list, the
audit trail and every prompt would otherwise keep a copy of the secret.

**Creation time is first-class.** `createdAt` is set once and never rewritten. The panel
shows it, the tools return it as both epoch and ISO, and the dispatch prompt includes it,
because "when did this land on my plate" is half of what a global todo is for.

**One write path.** The panel and the tools both call the same service functions, so a
validation rule, an audit entry or the write lock cannot exist on one side only.

**A failed hand-off is louder than a successful one.** Success and failure are both
recorded on the todo, and the panel shows the failure with its reason. A dispatch that
silently did nothing is worse than one that never happened.

**Optional services degrade, they do not crash.** `webServer`, `tools`, `agents`,
`agentPresets`, `workspaceRegistry` and `agentDefaultModel` are all reached through
`ctx.inject` or a guarded `ctx.get`. A lean composition loses exactly that surface.

See [docs/DESIGN.md](docs/DESIGN.md) for the data model and the rejected alternatives,
and [docs/ROADMAP.md](docs/ROADMAP.md) for what could come next.

## Development

```sh
npm run check     # parse every file, assert the shipping shape, and — when a DSH
                  # profile is present — validate every tool schema against the
                  # Host's own validator
npm test              # unit, contract and bundle tests, zero dependencies
npm run verify        # static checks + tests
npm run check:contracts  # the cross-field matrix a reviewer re-tests by hand:
                      # one invalid value, one answer, whichever field it lands on
npm run check:windows    # the same idea on a real filesystem (Windows in CI)
npm run check:matrix  # the running dsh against engines.dsh, then the manifest,
                      # bundle and tool-schema contracts (no preview writes)
```

`engines.dsh` is the one version fact that matters: a Host outside it skips the whole bundle
instead of warning, so `check:matrix` is the smoke to run before widening the range.

There is **no build step**. The host half is plain ESM under `lib/`; the client half is a
classic script that registers itself with `window.__ModuleLoader__`, so no bundler,
TypeScript toolchain or CI artifact is involved. `lib/client.js` edits take effect on a
page refresh; host-half edits need a host restart.

```sh
npm run preview       # render the panel to preview/panel.html (+ detail and selection variants)
npm run screenshots   # re-photograph those previews into docs/screenshots/, 1280×720
npm run tour          # rebuild docs/screenshots/tour.gif from those PNGs (needs ffmpeg)
```

The PNGs under `docs/screenshots/` ship with the package and are embedded in both
READMEs, so re-run `npm run screenshots` whenever the panel UI changes.

```text
lib/
  index.js       host entry: store + service + dispatcher + the optional surfaces
  store.js       one JSON file: atomic writes, serialized updates, tolerant loads
lockfile.js    the cross-process lock: exclusive create, pid/host liveness, stale takeover
  model.js       the todo entity: validation, patches, status, attachments, steps, review, notes
  links.js       attachment rules (pure: no filesystem access)
  service.js     the single write path, filters, sorting and the dispatch prompt
  routes.js      the HTTP surface for the panel
  tools.js       the eleven agent tools
  dispatch.js    handing a todo to an agent session (auto / bound / new / current)
  completion.js  the clean-turn watcher behind automatic completion
  capture.js     the capture duplicate gate (title, paraphrase, recent done)
  ingest.js      the external door and its inbox rules
  markdown.js    Markdown export and tolerant import
  report.js      the weekly aggregate over completion records
  reminders.js   the due rule behind the reminder strip
  settings.js    host-side switches and the automatic-collect policy
  metrics.js     in-memory counters reported by /health
  diagnostics.js the bounded client error log
  errors.js      typed failures with stable machine codes
  client.js      the browser half (panel + sidebar entry)
test/            unit, service, tool, route, dispatch, bundle and manifest tests
tools/           preview.mjs — render the panel to static HTML without a Host
                 screenshot.mjs — photograph those previews (borrows the profile's Playwright)
                 tour.mjs — assemble the README tour GIF from those PNGs
docs/            DESIGN.md (data model and rejected alternatives), ROADMAP.md
```

Contributions are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Feedback

Questions, bug reports and ideas go to [Discussions](https://github.com/LUgABeEEE/dsh-global-todo/discussions).
When reporting a bug, include the DSH version, the plugin version from the panel footer, your OS and
the steps that reproduce it; a screenshot of the notice is worth more than a paragraph. Security
issues go through [SECURITY.md](SECURITY.md) instead, not the discussion board.

## Security

The HTTP surface is local-only, the list is a local file, and no credential is ever stored.
Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 LUgABeEEE

A community plugin, not a DeepSeek project: the `dsh` prefix marks the ecosystem it plugs into, not
an endorsement. "DeepSeek" and "DeepSeek Harness" remain their owners' marks.
