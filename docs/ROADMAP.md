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
- Ten `global_todo_*` tools — `add`, `capture`, `list`, `get`, `update`, `link`, `note`,
  `done`, `remove`, and `reopen`, which followed in 0.3. What `/health` reports as
  `tools.registered` is the list as it stands, and panel and tools share the same validation.
- Four hand-off modes, with success **and failure** recorded on the record.
- Restore/undo for a delete, keyboard shortcuts, editable detail panel.
- Proactive capture: `global_todo_capture` for batches, plus guidance that says when the
  agent should record something itself and when it must not.

### Landed in 0.6

The panel became one column with one type scale, and every conditional state got a baseline.

- **The layout is a column, not a wrapping row** (`0.6.0`); the header wraps its actions, the
  toolbar is two semantic rows, and the directory / handoff / browse controls sit behind a single
  Context toggle. Five type sizes, one 28px control height, a 340px settings inspector instead of
  an in-flow block.
- **The settings panel was rebuilt as an inspector** (`0.6.4`): title row, three labelled groups,
  help text under every field, a pinned save row, and About showing the data file and version.
- **Every conditional state has an image** (`0.6.3`, `0.6.8`): empty list, filter with no match,
  inbox, due reminder, selection, settings. `npm run screenshots` photographs them from the same
  `SCENARIOS` table the static preview renders, and `npm run check:render` asserts each state's
  marker, so a blank picture fails CI instead of shipping.

### Landed since 0.1

Things that used to sit on the Next list (or in the Later table) and are facts in the
tree now.

**A lock across processes** — until 0.18.0 `store.update` only had a promise chain, which
serializes writers inside one process and says nothing about a second one; two Host processes
could each read the list, and the slower `rename` erased the other change while both calls
returned success. Every mutation now creates `<store>.lock` with `open(…, 'wx')` before reading,
releases it after the rename, and answers `store-busy` (503) after five seconds instead of writing
anyway (`lib/lockfile.js`, `lib/store.js`). A dead holder on the same host is reaped at once; a
remote one after 30 s. What it cannot cover — older plugin versions, hand edits, a sync client
writing at an arbitrary moment — is stated in FAQ 9 and DESIGN.

**A phone page that folds, and a fold that is a gesture** — at 600px or less the panel is a touch
surface: a 44px header line, a three-row toolbar (filters / search / grouping), 66px rows, 44px
controls and the safe area respected. Scrolling down past 80px folds the search line away, but only
after clearing the 110px it gives back — a 48px flick up or the top unfolds it, and either direction
is deaf for 300ms after a flip, which is what stopped a resting thumb from oscillating. A folded row
keeps its title plus the signals that change what to do next; the open row stays whole, and
attachments fade rather than vanish so the height does not move. Read on 390×844 the list starts at
287px with eight rows on the first screen. The dispatch summary and the auto-collect switch left the
phone toolbar for the settings sheet (one function renders both places), and 选择 moved after the
search field. The desktop is pixel-identical — `check:render` asserts 601 / 900 / 1280 / 1440 — and
`dsh-mobile` needs no configuration. Tests: `tools/preview.mjs` phone fixtures, the mobile baselines
in `docs/screenshots/mobile/`.

**Grouping by workspace, for real** — the first group mode is the directory the work was written in
(`originDir`, falling back to the session directory; neither means 手动添加), headed by the last
segment with the full path as its tooltip. A workspace group never auto-collapses, the per-group
exemption keys on exactly what the group is, and an old `conversation` preference still resolves to
a grouping the reader recognises. Labels: 工作区 / 时间 / 待办等级.

**Two machines, one list** — 0.21.0 turns "keep the list in a synced folder" into something the
plugin actually understands. Each machine still owns a local file; both fold through a
`todos.hub.json` in a shared directory (the panel's 设置 → 多端同步, or `config.sync.dir` for a
headless install), and `lib/replica.js` merges by record:
later `updatedAt` wins, a deletion travels as a tombstone (`trash`, a year, 5000 entries), and `seq`
is renumbered from the record set so two offline machines cannot both hand out #332. The fold is
commutative and idempotent, so a retried or concurrent sync cannot lose a record, and a sync that
changes nothing writes nothing. Reading the list never touches the share: `/health.sync` reports the
last attempt instead of making the panel wait on a mount. Deliberately not attempted: field-level
merges, a server, and attachment bytes (see DESIGN.md). Tests: `test/replica.test.mjs`,
`test/sync.test.mjs`, contract group K.

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
**Side detail on wide windows** — when the panel itself is at least 960px wide, the open row's
detail becomes a card at the panel's right edge instead of pushing the list down (CSS-only over
the same markup; one detail implementation), while narrow windows keep the inline expansion. The
breakpoint follows the panel's measured width, and the card is `position: fixed` with a measured
anchor — `DESIGN.md` records the two alternatives that were measured and rejected, so this is not
re-litigated every time someone tries to "clean it up".
**External ingest with an inbox** — `POST /ingest` takes source-tagged, confidence-scored items
behind a Bearer token; low-confidence records wait in an `inbox` tag view with 确认 / 丢弃 and a
seven-day sweep, so an external source cannot silently fill the list.
**An agent's "done" is a claim** — finishing as an agent sets `review = { pending }`, whether the
model reported it or the dispatch watcher closed a clean turn; a person
confirms or sends it back through `POST /review` (`reviewTodo()` in `lib/model.js`, `review()` in
`lib/service.js`). Confirming keeps the record finished; rejecting reopens it and drops the
completion record, because "not actually done" is the only honest reading. The panel shows a
待确认 chip, a 待确认 filter and 确认完成 / 退回清单; bulk confirm exists in that view.
`counts.review` drives the chip. Tests: `test/model.test.mjs`, `test/routes.test.mjs`.
**A design system with guards** — five type sizes (20/14/13/12/11), four control heights, one
settings inspector, and no JavaScript layout measurement left in the panel. Three guards keep it
that way: `test/locale.test.mjs` (duplicate keys, zh/en parity, full-width punctuation in English,
missing `t()` keys), the scenario table in `tools/preview.mjs` (empty, filtered, inbox, review,
reminder) photographed into `docs/screenshots/` by `npm run screenshots`, and
`npm run check:render` asserting each state's marker.
### Partly landed

- ~~**Session read-back**~~ — landed: `GET /session?id=` returns `alive`, `dir` and the last
  assistant `tail` (`lib/routes.js`, `sessionTails` in `lib/index.js`), and the detail panel shows
  that line (`lib/client.js`). It stays cheap and failure-tolerant: a conversation this process
  has not seen speak answers `null`, which is the normal case for an old hand-off.
- ~~**What the agents produced**~~ — landed: `GET /report?days=7` aggregates completion records
  into finished items, conversations, touched files and the review backlog (`lib/report.js`), and
  the panel shows it from `⋯ → 本周报告`.
- **Attachment health** — a dead file link is flagged on read, but there is no 「重新挂载」 next
  to it (`relink` does not exist anywhere in `lib/`), and `annotateLinks()` has no unit test:
  today the render assertion in `tools/preview.mjs` is the only coverage.
- **Batch** — selection, 一键分配, 完成 / 归档 / 打标签 and 批量确认（待确认视图）are all in.
  Nothing here is missing; it is listed because the panel is where the batch surface lives.

## Next

Ordered by value against effort, and audited against the tree on 2026-10-20 — "today"
means what the code actually does, not what the last plan hoped.

### 1. ~~Checklist inside a todo~~ — landed in 0.8.0

`steps[]` (text + tick) ships on the todo, renders as `步骤 2/4` in the row and as ticks in the
detail, is editable from the panel's add form, and travels in the dispatch prompt as a numbered
plan. `normalizeSteps()` in `lib/model.js`, `dispatchPrompt()` in `lib/service.js`; tests in
`test/model.test.mjs` and `test/service.test.mjs`.

What is left of the original idea: making a step addressable on its own (a tool that ticks step 3
without resending the array) — not worth a tenth tool today.

### 2. ~~Session read-back~~ — landed in 0.12

`GET /session?id=` answers `alive`, `dir` and the last assistant `tail`, and the detail panel
shows that line instead of a bare "still alive" flag. `lib/completion.js` keeps the tail it
already reads for its own closing logic; a conversation this process has not seen speak answers
`null`, which is a normal case rather than an error.

### 3. ~~Markdown import and export~~ — landed in 0.10.0

`GET /export?format=md` writes a task list with indented metadata; `POST /import` with
`{ markdown }` reads it back through `create` (new items, never an overwrite — Markdown has no
ids, so a shared id must not be able to replace a record). Parser is tolerant: a bad date is
dropped, unknown lines ignored, an empty task line is not a todo. Tests: `test/markdown.test.mjs`.

TaskPaper is still not implemented, and deliberately: the Markdown shape covers "diff it in a
repo", and a second text format is a second parser to keep honest.

### 4. ~~The weekly agent report~~ — landed in 0.10.0

`GET /report?days=7` aggregates completion records into finished items (newest first), the number
of conversations involved, files touched with counts, and how many wait for review — derived every
time, never stored. The panel shows it from `⋯ → 本周报告`. Tests:
`test/markdown.test.mjs` (pure aggregation) and `test/routes.test.mjs`.

### 5. ~~Image attachments~~ — landed in 0.15.0

`kind: 'image'` beside `url` / `file`: still an absolute reference (the store never holds
bytes), required to carry a renderable extension, with `GET /asset?id=&index=` reading the
path out of the record rather than from the request (8 MB cap, `nosniff`, image links only).
The row shows a thumbnail and the detail a preview; a dead image keeps the existing
missing-file chip instead of rendering a broken frame. `lib/links.js`, `lib/routes.js`,
`lib/client.js`; tests in `test/links.test.mjs` and `test/routes.test.mjs`.

### 6. Source adapters for the ingest door

`POST /ingest` exists and is fenced by a token; nothing pushes to it.

- Today: the door, the inbox, the confidence threshold and the seven-day sweep are done.
  There is no mail/notification reader anywhere in the repo.
- Effort: large, and the mode of the work is different: every adapter is an external
  dependency with its own failure modes. Do it when a real source exists, not before.

### 7. ~~Small, well-understood items~~ — landed in 0.16.0

- **`before:` / `after:` date bounds** in the search syntax, applied to the deadline and strict
  at the bound (`lib/service.js`); a half-typed date stops filtering instead of erroring on
  every keystroke.
- **「重新挂载」** beside a dead attachment (`POST /relink`, same shape as `/update`), plus the
  `annotateLinks()` unit test the code owed — including the image kind, which the annotation
  used to skip.
- **Accessibility pass**: the toast is a polite live region, errors are alerts, groups and rows
  are list items, filter buttons report `aria-pressed`, and every icon-only button carries a
  name (`test/a11y.test.mjs` guards all of it).

### Landed after this list was written

Due reminders (0.5.2), batch completion and tagging (`/bulk`), archive instead of
delete, cross-machine change notices, external ingest with an inbox — all four used to be
items here. See `Landed since 0.1` above; the entries were removed rather than left to
mislead.

The phone layout was never on this list and still shipped: the panel switches on its measured
width at 600px (`data-mobile`), with 44px touch targets, side-scrolling filter chips, the inline
hand-off collapsed to its icon, safe-area padding, and type that follows the shell's text-size
setting. `tools/preview.mjs --width` made it renderable from a script, which is why it had a
baseline before it had a device. See `docs/DESIGN.md`, "On a phone the panel is a touch surface".

## Later

| Idea | Note |
|---|---|
| Official `storageDomain` backend | A second store backend behind the same interface; the file stays the default because it is the feature. Today there is one backend and it says so (`kind: 'json'`, `lib/store.js`). |
| Virtualised list | Only needed past a few hundred rows; measure first. Nothing in `lib/client.js` virtualises today. |
| Drag to reorder | Manual order is meaningful to some people; it also needs a stable `position` field and a decision about how it interacts with due-date grouping. |
| Multi-list / projects | A `list` field with one default list; deferred because "global single list" is the current identity. |

## Not there yet

Things the list does not have today. Some may arrive later; none of them is a promise.

- **Calendar and board views.** The panel is a list with three groupings today. There is no
  calendar view and no drag-and-drop board.
- **Auto-running todos.** Nothing starts work on a schedule today; the list records what a
  person intends to do.
- **Copying attachment bytes.** Attachments are references (absolute path or URL) today; see
  `DESIGN.md` for why references beat stale copies.
- **A second source of truth.** Everything reads and writes the one JSON file today; anything
  that mirrors it elsewhere (a database, a remote service) would have to justify itself.
