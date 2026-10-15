# Roadmap

What could come next, ordered by value against effort. Everything here is a
proposal, not a commitment.

This file was audited against the tree: everything under **Landed** is in the code
today, with the `file:line` that shows it. Line numbers move, so the durable part
of a citation is the function or the label beside it.

## Landed

### Landed in 0.1

- Global list, one JSON file, atomic writes, one write path for both writers.
- Creation time on every entry, immutable and shown everywhere.
- Attachments as references: any number of documents and addresses per todo.
- Nine `global_todo_*` tools — `add`, `capture`, `list`, `get`, `update`, `link`, `note`,
  `done`, `remove` (the same list `/health` reports as `tools.registered`); panel and tools
  share the same validation.
- Four hand-off modes, with success **and failure** recorded on the record.
- Restore/undo for a delete, keyboard shortcuts, editable detail panel.
- Proactive capture: `global_todo_capture` for batches, plus guidance that says when the
  agent should record something itself and when it must not.

### Landed since 0.1

Things that used to sit on the Next list (or in the Later table) and are facts in the
tree now.

**Attachment health** — a file link is probed when the list is read, never when it is
stored: `annotateLinks()` (`lib/service.js:347`) sets `missing: true` for a path
that no longer resolves (`lib/service.js:360`), and both read routes apply it
(`GET /list` `lib/routes.js:257`, `GET /get` `lib/routes.js:311`). The panel
shows the chip on the row and in the detail (`lib/client.js:1408`,
`lib/client.js:1678`) with the label 「文件不在了」 (`lib/client.js:209`); the render
check asserts it (`tools/preview.mjs:572`).

Still owed from the original idea: 「重新挂载」 next to a dead link, and a unit test for
`annotateLinks` itself — today the render assertion is the only coverage.

**Smarter search** — `parseQuery()` (`lib/service.js:129`) turns `tag:发布`,
`#发布`, `level:p0` (aliases at `lib/service.js:117`), `is:…` and `has:…` into
filters, and `matchesSyntax()` (`lib/service.js:152`) applies `is:overdue`,
`is:due`, `is:active`, `has:link`, `has:note` and `is:<status>`; free text
still has to match every word (`lib/service.js:196`). The panel advertises the syntax
on the search box (`lib/client.js:210`, `lib/client.js:2705`) and the render check
asserts the hint (`tools/preview.mjs:573`). Test: `test/service.test.mjs`, "the
search box understands tag:, is:, has: and level: tokens".

Not landed from the same idea: `before:` / `after:` date bounds.

**Progress notes** — an append-only trail per todo: `addNote()` (`lib/model.js:387`),
repaired on load by `normalizeNotes()` (`lib/model.js:361`), reached through
`note()` (`lib/service.js:329`), `POST /note` (`lib/routes.js:423`) and the agent
tool `global_todo_note` (`lib/tools.js:618`), and shown as 「进展记录」 in the detail
(`lib/client.js:200`, `lib/client.js:1648`). Tests: `test/model.test.mjs:210`,
`test/tools.test.mjs:301`, `test/routes.test.mjs:495`.

**JSON export and import** — `GET /export` hands back the store's own document and
`POST /import` writes one back (`lib/routes.js:320`, `lib/routes.js:332`), through
`exportDocument()` / `importDocument()` (`lib/service.js:536`,
`lib/service.js:554`). `replace` is a byte-for-byte round trip; `merge` updates by
id and appends what is new. The panel has 导出 / 导入 in the header
(`lib/client.js:2570`, `lib/client.js:2580`) and imports in merge mode on purpose: a
file picked by mistake must not erase the list. Round trip: `test/transfer.test.mjs`,
"an export imported back reproduces the list exactly".

Not landed: the Markdown / TaskPaper formats this entry used to ask for, and the 1 MiB
request cap stays (`lib/routes.js:32`), so a list exported beyond that size cannot be
imported back through the route.

**Metrics in /health** — the health reply now carries `metrics`
(`lib/routes.js:349`): dispatch success rate, agent tool call counts, and list growth
(created / removed / restored / imports / noted, current size, peak), built in
`lib/metrics.js`. The counters are in memory and reset with the Host, and the field is
`null` when nothing mounted them — an absent metric is not a zero. Test:
`test/metrics.test.mjs`.

### Partly landed

- **Batch and multi-select** — the selection mode, its per-row markers and the batch
  一键分配 are in (`lib/client.js:2209`, `lib/client.js:2884`, `POST /assign` at
  `lib/routes.js:413`, `assignMany()` at `lib/dispatch.js:195`; tests
  `test/dispatch.test.mjs:657`). Batch 完成 / 打标签 across a selection do not exist.
- **Session read-back** — `sessionAlive` is on every listed todo
  (`lib/routes.js:259`, `lib/dispatch.js:698`). Reading what that session last said,
  and linking to it, is not: `lib/completion.js` reads `assistant/message` only to
  close a todo this plugin dispatched, and stores one summary in its completion record.
- **What the agents produced** — the per-todo record with a summary and the changed
  files landed (`completeTodo()` at `lib/model.js:415`, 「完成记录」 at
  `lib/client.js:1648`, the 已完成 filter and group at `lib/client.js:153`). The
  cross-todo "what did the sessions finish this week, and what did they touch" view did
  not.

## Next

### 1. Checklist inside a todo

Large items ("ship the plugin") are really a list of steps. Proposed: an optional
`steps[]` on a todo, rendered as checkboxes, and shipped to the agent as a numbered
plan in the dispatch prompt.

- Effort: medium (model + tools + panel + prompt builder).
- Today: nothing named `steps` exists anywhere in `lib/`, so this is untouched.
- Why it matters: it removes the need for a separate "plan" plugin, and the dispatch
  prompt gets materially better.

### 2. Session read-back

The panel shows whether the bound session is alive (`sessionAlive`). Next: show what
that session last said — one line of its latest assistant message, and a link to open it
— so a dispatched todo reports back where the work is.

- Effort: medium. Needs a host-side read of the bound session (the `sessions` service
  exists, but this must stay cheap and failure-tolerant).
- Why it matters: hand-off stops being fire-and-forget.

### 3. Due reminders

A reminder when a due time passes, in the GUI and optionally to the IM channel this
deployment already has.

- Effort: medium. The plugin has no scheduler today (nothing in `lib/` matches
  `remind`); the Host's timer service plus a config flag is the smallest version.
- Careful: **remind only, never auto-dispatch.** The list belongs to the human; starting
  work stays an explicit act. (Auto-dispatch was rejected in `DESIGN.md` for this
  reason.)

### 4. Batch completion and tagging

Shift-click to select, then 完成 / 打标签 across the selection — the half of
multi-select that did not land with batch assignment.

- Effort: small (one bulk route beside `/assign`, one button beside 一键分配).

### 5. Import and export beyond JSON

Markdown / TaskPaper in and out, so the list can be migrated from (and to) any other
tool and diffed in a repo.

- Effort: medium. JSON is done; the text formats are the remaining work.

### 6. What the agents produced

Completions already record a summary and the changed files per todo. A cross-todo view —
"what did the sessions finish this week, and what did they touch" — would turn that into
something you can review, and would be the honest way to show that a hand-off did work.

## Later

| Idea | Note |
|---|---|
| Image attachments | `kind: 'image'` next to `url` / `file`. The shape is already prepared for it, but `LINK_KINDS` is still `['url', 'file']` (`lib/links.js:21`). |
| Official `storageDomain` backend | A second store backend behind the same interface; the file stays the default because it is the feature. Today there is one backend and it says so (`kind: 'json'`, `lib/store.js:212`). |
| Virtualised list | Only needed past a few hundred rows; measure first. Nothing in `lib/client.js` virtualises today. |
| Drag to reorder | Manual order is meaningful to some people; it also needs a stable `position` field and a decision about how it interacts with due-date grouping. |
| Multi-list / projects | A `list` field with one default list; deferred because "global single list" is the current identity. |
| Archive instead of delete | Keeps history without cluttering. `POST /remove` deletes for real (`lib/routes.js:445`); only the panel's short undo brings a record back. |
| Cross-machine conflict notice | The file is portable (NAS, sync folder). Detect "changed underneath me" and offer a reload instead of a silent overwrite — `store.read` still trusts the file whenever it parses. |
| Capture from outside the chat | Notifications, mail, announcements — the sources `dsh-todo-list` reads. Needs an ingest path and a policy for deduplication; `POST /capture` only asks a conversation to collect (`lib/routes.js:418`). |
| Accessible-only sweep | Full keyboard path is close; a screen-reader pass over the panel and the group headers is still owed. |

## Explicitly not planned

- **Auto-running todos.** A schedule that starts work without a person is a job queue,
  and this is a personal list.
- **Copying attachment bytes.** See `DESIGN.md`: references beat stale copies.
- **A second source of truth.** Anything that mirrors this list elsewhere (a database, a
  remote service) has to justify why the file is not enough.
