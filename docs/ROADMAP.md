# Roadmap

What could come next, ordered by value against effort. Everything here is a
proposal, not a commitment.

This file was audited against the tree: everything under **Landed** is in the code
today, cited by the file and the function that shows it. Line numbers were removed
after they drifted by dozens of lines: the function or the label beside a citation
is the durable part, and a stale number is worse than none.

## Landed

### Landed in 0.1

- Global list, one JSON file, atomic writes, one write path for both writers.
- Creation time on every entry, immutable and shown everywhere.
- Attachments as references: any number of documents and addresses per todo.
- Nine `global_todo_*` tools — `add`, `capture`, `list`, `get`, `update`, `link`, `note`,
  `done`, `remove`; `reopen` joined them later (below). What `/health` reports as
  `tools.registered` is the list as it stands, and panel and tools share the same validation.
- Four hand-off modes, with success **and failure** recorded on the record.
- Restore/undo for a delete, keyboard shortcuts, editable detail panel.
- Proactive capture: `global_todo_capture` for batches, plus guidance that says when the
  agent should record something itself and when it must not.

### Landed since 0.1

Things that used to sit on the Next list (or in the Later table) and are facts in the
tree now.

**Attachment health** — a file link is probed when the list is read, never when it is
stored: `annotateLinks()` (`lib/service.js`) sets `missing: true` for a path
that no longer resolves (`lib/service.js`), and both read routes apply it
(`GET /list` `lib/routes.js`, `GET /get` `lib/routes.js`). The panel
shows the chip on the row and in the detail (`lib/client.js`,
`lib/client.js`) with the label 「文件不在了」 (`lib/client.js`); the render
check asserts it (`tools/preview.mjs`).

Still owed from the original idea: 「重新挂载」 next to a dead link, and a unit test for
`annotateLinks` itself — today the render assertion is the only coverage.

**Smarter search** — `parseQuery()` (`lib/service.js`) turns `tag:发布`,
`#发布`, `level:p0` (aliases at `lib/service.js`), `is:…` and `has:…` into
filters, and `matchesSyntax()` (`lib/service.js`) applies `is:overdue`,
`is:due`, `is:active`, `has:link`, `has:note` and `is:<status>`; free text
still has to match every word (`lib/service.js`). The panel advertises the syntax
on the search box (`lib/client.js`) and the render check
asserts the hint (`tools/preview.mjs`). Test: `test/service.test.mjs`, "the
search box understands tag:, is:, has: and level: tokens".

Not landed from the same idea: `before:` / `after:` date bounds.

**Progress notes** — an append-only trail per todo: `addNote()` (`lib/model.js`),
repaired on load by `normalizeNotes()` (`lib/model.js`), reached through
`note()` (`lib/service.js`), `POST /note` (`lib/routes.js`) and the agent
tool `global_todo_note` (`lib/tools.js`), and shown as 「进展记录」 in the detail
(`lib/client.js`). Tests: `test/model.test.mjs`,
`test/tools.test.mjs`, `test/routes.test.mjs`.

**JSON export and import** — `GET /export` hands back the store's own document and
`POST /import` writes one back (`lib/routes.js`), through
`exportDocument()` / `importDocument()` (`lib/service.js`,
`lib/service.js`). `replace` is a byte-for-byte round trip; `merge` updates by
id and appends what is new. The panel has 导出 / 导入 in the header
(`lib/client.js`) and imports in merge mode on purpose: a
file picked by mistake must not erase the list. Round trip: `test/transfer.test.mjs`,
"an export imported back reproduces the list exactly".

Not landed: the Markdown / TaskPaper formats this entry used to ask for, and the 1 MiB
request cap stays (`lib/routes.js`), so a list exported beyond that size cannot be
imported back through the route.

**Metrics in /health** — the health reply now carries `metrics`
(`lib/routes.js`): dispatch success rate, agent tool call counts, and list growth
(created / removed / restored / imports / noted, current size, peak), built in
`lib/metrics.js`. The counters are in memory and reset with the Host, and the field is
`null` when nothing mounted them — an absent metric is not a zero. Test:
`test/metrics.test.mjs`.

**Reopen, with an honest trail** — a wrongly-finished todo has a dedicated way back:
`reopen()` (`lib/service.js`) does `done` / `cancelled` → `open` and refuses anything else,
reached by the tool `global_todo_reopen` (`lib/tools.js`); the reason it records lands in
the activity trail via `setStatus()` (`lib/model.js`). Writing through
the panel's routes no longer forces a false provenance: `/update` and `/status`
(`lib/routes.js`) take an explicit `by: 'agent'` and default to the
person, and anything else is a 400 (`actorOf` at `lib/routes.js`). Tests:
`test/tools.test.mjs`, `test/routes.test.mjs`.

Not landed: the same `by` on `/create`, `/note`, `/remove` and `/link`, which still record the
person — the agent has its own tools for those. `/restore` (the panel's undo) has no agent-facing
equivalent at all, so nothing there can be misattributed today.

**Automatic collect with a memory** — the decision layer keeps its reasons: `/health` reports
every waiting candidate's verdict (`off`, `exempt-workspace`, `unknown-dir`, `retry-wait`,
`awaiting-human`, `not-idle-yet`, `cooldown`), the last one, and in-memory counters for
asked / succeeded / failed / dropped (`explainAutoCollect` in `lib/settings.js`, `autoCollectState`
in `lib/index.js`). A failed question releases its booking and retries after 1 / 5 / 25 minutes
(`retryDelayMs`), and an ask that never settles is bounded by a ten-second timeout. An unknown
working directory is never asked, because the exemption cannot be checked against it.
**Batch completion and tagging, and archive** — `/bulk` applies a status or tag change across a
selection in one request; a stale id is reported in `unmatched` instead of discarding the batch
(`bulk()` in `lib/service.js`, `runBulk` in `lib/client.js`). `archived` joined the statuses, so a
record can leave the active view without being deleted; the filter chip only appears once something
is archived, and `global_todo_update` finally accepts `status`.
**A capture gate, not a title comparison** — before `global_todo_capture` writes an item it asks
`findDuplicate` (`lib/capture.js`): normalized title against live rows, a close paraphrase inside
72 hours, and the same errand finished in the last 7 days. The decision is pure, the reason lands
in `skipped[]`, and archived/cancelled rows deliberately do not block a new one.
**A change made elsewhere is visible** — the store fingerprints the file on every read/write and
counts a disagreement once (`externalChanges`, `lastExternalAt` in `lib/store.js`; surfaced by
`/health.store`). The panel shows a one-line notice instead of letting a synced folder change the
list silently.
### Partly landed

- **Batch and multi-select** — the selection mode, its per-row markers and the batch
  一键分配 are in (`lib/client.js`, `POST /assign` at
  `lib/routes.js`, `assignMany()` at `lib/dispatch.js`; tests
  `test/dispatch.test.mjs`). Batch 完成 / 打标签 across a selection do not exist.
- **Session read-back** — `sessionAlive` is on every listed todo
  (`lib/routes.js`, `lib/dispatch.js`). Reading what that session last said,
  and linking to it, is not: `lib/completion.js` reads `assistant/message` only to
  close a todo this plugin dispatched, and stores one summary in its completion record.
- **What the agents produced** — the per-todo record with a summary and the changed
  files landed (`completeTodo()` at `lib/model.js`, 「完成记录」 at
  `lib/client.js`, the 已完成 filter and group at `lib/client.js`). The
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
| Image attachments | `kind: 'image'` next to `url` / `file`. The shape is already prepared for it, but `LINK_KINDS` is still `['url', 'file']` (`lib/links.js`). |
| Official `storageDomain` backend | A second store backend behind the same interface; the file stays the default because it is the feature. Today there is one backend and it says so (`kind: 'json'`, `lib/store.js`). |
| Virtualised list | Only needed past a few hundred rows; measure first. Nothing in `lib/client.js` virtualises today. |
| Drag to reorder | Manual order is meaningful to some people; it also needs a stable `position` field and a decision about how it interacts with due-date grouping. |
| Multi-list / projects | A `list` field with one default list; deferred because "global single list" is the current identity. |
| Archive instead of delete | Keeps history without cluttering. `POST /remove` deletes for real (`lib/routes.js`); only the panel's short undo brings a record back. |
| Cross-machine conflict notice | The file is portable (NAS, sync folder). Detect "changed underneath me" and offer a reload instead of a silent overwrite — `store.read` still trusts the file whenever it parses. |
| Capture from outside the chat | Notifications, mail, announcements — the sources `dsh-todo-list` reads. Needs an ingest path and a policy for deduplication; `POST /capture` only asks a conversation to collect (`lib/routes.js`). |
| Accessible-only sweep | Full keyboard path is close; a screen-reader pass over the panel and the group headers is still owed. |

## Explicitly not planned

- **Auto-running todos.** A schedule that starts work without a person is a job queue,
  and this is a personal list.
- **Copying attachment bytes.** See `DESIGN.md`: references beat stale copies.
- **A second source of truth.** Anything that mirrors this list elsewhere (a database, a
  remote service) has to justify why the file is not enough.
