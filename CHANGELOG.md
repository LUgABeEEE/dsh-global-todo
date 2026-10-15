# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`/health` now reports what the plugin has been doing.** In-process counters for the list
  (`created`, `removed`, `restored`, `imports`, `noted`, `changes`, `size`, `peak`) and for
  hand-offs (`attempts`, `ok`, `failed`, `byMode`, `successRate`), plus a per-tool call count that
  includes failures. The existing fields are untouched; `metrics` is `null` when the plugin is
  mounted without a store. Deliberately **in-memory**: it describes this process, and a counter
  that survives a restart is a second source of truth for facts the store already owns.
- **The list can be exported and imported as JSON.** `GET /export` returns the store's own
  document — not the read view, so the runtime annotations (`missing`, `sessionDir`) are absent —
  and `POST /import` accepts it back with `replace` or `merge` semantics (`merge` overwrites by id
  and appends new ones). A single unreadable record fails the whole request with a 400 rather than
  writing half of it. The panel gained 导出 / 导入 buttons; the import path defaults to `merge` so
  choosing the wrong file cannot empty the list.
- The tool count in the docs now matches the tree: **nine** `global_todo_*` tools
  (`add`, `capture`, `list`, `get`, `update`, `link`, `note`, `done`, `remove`), the same list
  `/health.tools.registered` reports. `ROADMAP.md` was re-audited against the code and now
  separates what has landed (with `file:line` citations) from what has not.

## [0.2.0] — 2026-10-15

The first published release. 0.1.0 was cut in the repository but never reached a
registry, so this is the version to install.

### Fixed

- **A settings write that landed during startup was silently undone.** The Host reads
  `settings.json` without awaiting the read — it cannot block its own mount on a file — and that
  read replaces the whole settings state. A panel toggle, or a cooldown booking from an
  automatic ask, that arrived while the read was still in flight was therefore overwritten by
  the file that read had just loaded. Writes now wait for the startup read to finish.
- **The diagnostics log is trimmed without ever being seen empty.** The bound was enforced by
  rewriting `client-errors.log` in place, and `writeFile` truncates its target before it writes,
  so a reader that landed in that window got 0 bytes — the CI reader that expected the newest
  report got `''`. The trim now writes a sibling file and renames it over the log, which is
  atomic, and a failed trim leaves no litter beside the log.

### Fixed

- **The hand-off picker now mirrors the shell's own visibility rule.** It was offering
  conversations the sidebar deliberately hides: **subagent children** (`origin === 'subagent'`),
  **blank sessions** that are not the one in front of the user, and archived sessions whose
  archived set came from a source the picker read too narrowly. The rule is copied from
  `sessionVisible` in the shipped workspace package — the only authority on it — including its one
  exception: a blank session *is* offered while it is the current one. The picker also reports the
  shape of the session snapshot it sees to `/health.clientErrors` once per mount, because a preview
  fixture written by the same hand as the filter can only ever confirm itself.

- **A long working directory no longer breaks its own label.** `工作目录：` is a flex child of the
  directory pill, so when the row overflowed it shrank and wrapped mid-word — and the third
  button (`浏览`) was enough to push it over. Only the path yields now: it already ellipsises,
  while the label, the hint and the buttons keep their size.

### Added

- **A folder browser, because the shell's picker is not always mounted.** `uiWorkspace.pickDirectory()`
  delegates to a directory-picking Remote namespace that this deployment does not have, so it
  throws instead of opening anything (the panel had been reduced to asking you to type a path).
  The Host now serves `GET /api/global-todo/dirs` — visible sub-folders, sorted, capped, with the
  parent — and `选择` walks it as a real picker (`浏览`: current path, `上一级`, folder buttons,
  `用这个目录`). The path field stays for pasting, and the failure is still reported to
  `/health.clientErrors`.

### Changed

- **A calmer panel.** The header had grown two rows of controls that said the same things
  twice: the three count chips *were* the status filter, and the add form sat open above the
  list forever. Now there are three rows with one job each — **title + summary + `添加`**,
  **filters · grouping · search** in a single row, then a quiet **context line** (working
  directory, hand-off target, `选择`, `自动获取`). Counts moved into the summary line as plain
  text, every "pick one of these" control uses one segmented style (chips are now only facts
  about a todo: tags, levels, notes), and the add form opens from `添加` instead of occupying
  the top of the list.

- **The test suite waits for results, not for the clock.** The remaining fixed sleeps
  (`settle()`, `setTimeout`) are gone: the auto-collect, restart and dispatch tests now poll for
  the state their assertions are about, with a bounded timeout that names what it waited for. A
  sleep is a test that reports on the machine, and one of them was already losing that race on
  the slower CI runner.
- **CI runs `actions/checkout@v7` and `actions/setup-node@v7`**, which are already on Node 24,
  so the Node 20 deprecation warnings are gone. Automatic npm caching is off explicitly: this
  plugin has no dependencies and no lockfile to cache.

- **The repository is publishable as it stands.** Two things stood between this tree and a
  public one. The machine-path guard in `scripts/check.mjs` only looked at the shipped halves,
  so a preview fixture, a test constant and a screenshot caption each carried the author's real
  home directory while the guard still reported `OK`; it now covers every committable file and
  allows exactly one placeholder, `/home/me/…`. And `publish.yml` asked Node 22.19 for npm
  10.9.3, which cannot do OIDC at all — trusted publishing needs npm 11.5.1 or later — so the
  job installs that floor before it publishes. The internal research reports left `docs/`, and
  the fixtures and screenshots were regenerated from the same neutral data.

## [0.1.0] — 2026-10-14

The first release: one JSON list a person and an agent both write to, eight agent tools, a
panel that hands work over and records how it finished.

### Fixed

- **「选择」工作目录不再以一条无解的错误结束.** `uiWorkspace.pickDirectory()` exists, but it
  delegates to a directory-picking **Remote namespace** that is not mounted in every
  deployment, where calling it throws a bare
  `Cannot read properties of undefined (reading 'directoryPicker')`. The panel now falls back
  to a **path field** (`手动填` → paste an absolute path → `使用`), says plainly why, and reports
  the throw to the Host diagnostics so it is visible in `/health.clientErrors` instead of only
  in someone's browser.
- **Both capture actions and the automatic-collect switch reported an error even though they
  worked.** The handlers ended with `void refresh()` — a function that does not exist — so a
  successful request was immediately followed by a `ReferenceError` that the handler's own catch
  turned into an error banner. The write had already landed, which is also why the switch appeared
  impossible to turn off: the panel's copy of the Host settings was only read at mount, so the chip
  never moved and the next click sent the same value again. Health is now refreshed on the poll and
  updated optimistically on write, and `void refresh()` is gone.
- **A guard against that class of bug**: `tools/scan-client-calls.mjs` scans the shipped client for
  calls to functions nobody defined (comments and strings removed first; destructuring, parameters
  and method shorthand recognised), wired into `npm run check` and covered by its own test. Every
  other check passes such a mistake, and the preview harness cannot see it — an error caught inside
  a handler only appears on a real re-render.
- **The toolbar's own "collect from this chat" button is gone.** The action lives on each
  conversation's group header, where its subject is unambiguous; a second copy in the toolbar only
  gave the wrong one to click.
- **The Host's own tooling is no longer locked out by the connection fence.** Deferring to the
  fence fixed LAN access but made *every* credential-less request a 401, because the fence
  authenticates browsers — so `curl`, scripts on the Host and other agents lost access to a list
  they are the main writers of. The fence now judges **browsers** (anything carrying a cookie or
  an `Origin`), while a local, credential-less caller is judged by the loopback rule — the guard
  that existed before the fence did. A fence that throws still fails closed, and a cross-site
  request is never rescued by the carve-out. `/health` reports `fence.localScriptsAdmitted`.

- **The panel works from the LAN and from a tunnel again.** The Host's connection fence was read
  once at mount time, when it can still be absent, so every request fell through to the plugin's
  own loopback check. That check is stricter than the Host's trusted-host list: a browser anywhere
  but the Host machine got `403 只接受本机请求` on **every** call — list, picker and both capture
  actions — while `curl` from the Host looked perfectly healthy. The fence is now resolved per
  request, its verdict is honoured verbatim, and `/health` reports which fence is actually in
  force so a silent downgrade cannot hide again.

### Added

- **`全选` in selection mode.** Tick everything the panel is currently showing (collapsed groups
  included — their todos are still what the user means), and the same control becomes
  `取消全选` once everything is selected.

- **Batch assignment (「一键分配」)**. Turn on 「选择」 in the toolbar, tick a few todos, and one
  click sends each of them to the best target available for it — **the conversation that wrote
  it**, then a conversation in the **same workspace** (a candidate the panel works out from its
  own recency and archive data, which the Host cannot see), then a **target you choose** for the
  rest. Those are an attempt order, not a preference: a target that cannot be loaded is the
  reason the next one exists. Whatever still has nowhere to go is reported back and offered a
  picker instead of being sent somewhere nobody chose, and one failure does not abort the batch.
- **An automatic collect switch** (panel chip `自动获取`, `POST /api/global-todo/settings`). When
  it is on, a conversation you are in that finishes a clean turn and has not been asked for a
  while is asked once whether anything needs following up. It is off until a person turns it on,
  the switch lives on the Host (so it works with the panel closed and is reported by `/health`),
  and every reason *not* to ask is explicit: an aborted/failed turn, a conversation nobody is in,
  a session asked inside the cooldown, or the feature being off. The cooldown is booked before
  the question is asked, so a repeated event or a failed request cannot turn into a loop.
- **Stronger proactive guidance in the system prompt.** The section now lists the concrete
  triggers for recording something on one's own initiative (a cross-conversation follow-up, "I'll
  do X then Y", a leftover step at the end of a turn), says plainly that asking the user whether
  to record it is wrong, and points at `global_todo_note` for reporting a blocker instead of
  rewriting the description.

### Changed

- **"Collect from this chat" lives on the conversation it collects from.** A global toolbar
  button could not say *which* conversation it meant, so the action now sits on each
  conversation's group header in the list (`抓取`), and asking a group to collect files the
  results under that conversation. The toolbar keeps a fallback, shown *only* when the
  conversation in front of the user has no group yet — otherwise there would be no way to
  collect from it.
- **Collecting from a conversation that is not running now resumes it** (the same rule a
  hand-off follows). It used to look the session up in the live registry and die on
  `undefined` for any conversation that was not currently loaded.

### Added

- **The hand-off picker shows the conversations you actually use, newest first.** Its order is
  the sidebar's own recency key (`updatedAt`), so the conversation you were last in is at the
  top and stale ones sink, and **archived conversations are left out entirely** — an archived
  conversation is not an answer to "where should this work go". Conversations that share a
  title get a short id suffix so two options can be told apart, and if the current target is no
  longer listed (archived since it was chosen) it is shown as `（已归档）` rather than silently
  displaying a different conversation as selected.
- **Progress notes** (`global_todo_note`, `POST /api/global-todo/note`): an append-only trail of
  who said what and when, capped per todo. An agent reporting "here is where I am stuck" no
  longer has to rewrite the user's description, and — like the other verdict tools — writing a
  note makes automatic completion stand down rather than contradict a stated blocker. The row
  shows the count, the detail shows the trail and a box to add one.
- **Dead attachments are flagged where you see them.** File attachments that no longer exist
  are marked red on the row and labelled in the detail. The flag is computed on read and never
  stored, so a file that comes back stops being flagged and a stale flag cannot outlive the
  problem.
- **Search syntax**: `tag:发布` / `#运维`, `is:overdue|active|due|open|doing|done`, `has:link`,
  `has:note`, `level:p0|p1|p2|p3`, plus free words, which are combined with AND and also match
  note text. A plain search still behaves exactly as before.
- **A new conversation is placed where the work lives.** A hand-off that opens a session now
  joins the workspace owning the conversation that wrote the todo (or the one it was handed
  from), and starts in that workspace's directory — so the agent and the sidebar agree
  instead of the session landing beside unrelated ones. The panel also lists the workspaces,
  so a new conversation can be aimed at one explicitly (`＋ new conversation · <workspace>`);
  a named workspace outranks the inherited one. Only when neither is known does the working
  directory decide.
- **A pre-commit credential audit inside `npm run check`**: the rule the project used to
  apply only to shipped files now runs over every file a commit would carry (51 of them,
  with the same exclusions `.gitignore` applies), and it asserts that the local artifacts
  (`node_modules/`, `preview/`, `todos.json`, backups) cannot reach a commit at all. A
  credential leaked in a test or a doc is exactly as leaked as one in `lib/`.
- **`npm run check:live`** (`tools/live-check.mjs`): verifies the wired Host rather than
  doubles — health surfaces, a delete → undo round trip compared field by field, and the
  `sessionAlive`/`sessionDir` a row needs to show whether its conversation is running. It
  cleans up its temporary record even when it fails, and stays out of `verify` because it
  needs a reachable Host.
- **Levels P0–P3.** `urgent` joins the existing three levels (`P0 紧急 / P1 高 / P2 常规 /
  P3 低`), so no migration is needed: `high`/`normal`/`low` stay valid and `normal` stays the
  default. The badge marks P0 in the error colour to separate it from P1.
- **`POST /api/global-todo/capture` and the panel's 「从本对话抓取」 button**: the panel
  injects a capture request into the conversation the user is in, which then records its
  follow-ups with `global_todo_capture`. It is a request for work, not a hand-off: nothing is
  recorded against a todo and no completion is expected.
- **Grouping dimensions.** The panel groups by `conversation` (default), `time` or `level`.
  Conversation mode merges everything one agent conversation submitted into a single entry
  that carries the count, collapsing it until asked — a list that several 「抓一下待办」 runs
  filled up stops reading as a wall of rows. Items with no source conversation gather under
  「手动添加」, and the row level (high / normal / low) is visible as a badge and as the
  highest level of a conversation group.
- **A render check** (`npm run check:render`, part of `verify`): the client half has no unit
  seam, so the generated panel HTML is asserted instead — merged conversations stay one
  entry, single-item ones keep their row, levels and all three grouping buttons render, and
  no literal colour leaks into the markup.
- **Automatic completion.** A handed-off session that closes its turn cleanly finishes its
  todo by itself: the closing assistant message becomes `completion.summary` and the files
  that turn changed become `completion.artifacts`. Two guards keep it honest — only a
  session this plugin just dispatched to is eligible, and `error` / `aborted` /
  `interrupted` turns leave the todo open. `lib/completion.js` watches `session/event`
  (`assistant/message`, `workspace/changes`, `turn/end`) and resolves file lists through
  the `workspaceChanges` recorder when an event does not carry them.
- `global_todo_done` accepts `summary` and `artifacts`, so an agent can write the record
  itself; the completion prompt asks for them, and "don't mark it done if you couldn't" is
  stated in the hand-off message.
- The panel renders the completion: 完成于 on the row, artifact chips next to the
  attachments, and a completion section in the detail.
- `global_todo_capture`: record a batch of todos in one call, with per-entry validation so
  one bad attachment does not lose the rest.
- Proactive-capture guidance in the system prompt: when the agent should record something
  on its own initiative, when it must not, and 「抓一下待办」 as the phrase that asks it to
  scan the conversation and capture a batch. The boundary is stated in the prompt too:
  record, never start work.
- `POST /api/global-todo/restore` and the panel's undo: a deleted todo comes back
  verbatim — same id, creation time, attachments and history — and a record whose id
  is taken is refused rather than merged.
- `sessionAlive` on every listed todo, derived from the live agent registry on read, so
  the panel can say 「会话在跑」 instead of 「已绑定会话」.
- `npm run preview`: renders the panel (and an opened detail view) to static HTML with
  no Host and no dependencies, for UI work and review.

### Fixed

- **The receipt's jump button did nothing.** Client services arrive through
  `ctx.inject([...])`, not `ctx.get(...)`: the directory marks `uiWorkspace` as a hard
  dependency for exactly that reason. It is now obtained by injection, and the button is
  only rendered when `openSession` really exists — a button that does nothing is worse than
  no button.
- **A hand-off still landed in the wrong conversation.** Inference about "the conversation
  you are in" was wrong twice, so it is no longer the mechanism: the toolbar now lists the
  conversations and the user picks one (`交给：[ 对话名 ▾ ]`). An explicit pick is sent with
  `authoritative: true`, which the Host honours verbatim; the list marks the conversation the
  Host would have chosen on its own, `自动` keeps the old behaviour, and a pick is remembered.
- **A hand-off pulled the next hand-off with it.** The "conversation you were last in" came
  from `api-session/activity`, which reports *any* user-authored durable message — and a
  hand-off is one: the plugin injects a user-role message into its target. So every dispatch
  moved "the current conversation" to the conversation it had just dispatched to, and the
  next click followed the previous click instead of the person. The tracker now reads the
  session log and keeps only `user/message` events whose `source.kind` is `user`, so model
  turns, tool results and plugin injections cannot move it. The id is also kept next to the
  data (`recent-session.json`), because the tracker lives in memory and this plugin restarts
  with the Host: an empty tracker falls back to the panel's stale guess, which is how a
  hand-off reached the wrong conversation. Covered by two smoke tests — the message sequence,
  and a restart that must not forget.
- **A hand-off could start work silently in another conversation.** The panel said nothing
  after a successful dispatch, so a person staring at the todo list saw "no reaction" while
  the agent in a different conversation was already working. The panel now names the target
  and offers to open it, and the pre-click label uses the conversation the Host will actually
  pick (`/health`'s recent-session answer) instead of the panel's own guess.
- **The panel's guess about "the conversation on screen" outranked the real one.** While the
  panel is the main view, its idea of the current session is whatever the view retained
  earlier — hours stale in practice, and it sent work to the wrong conversation. The activity
  feed (a real user message) now wins; a caller that genuinely knows — a button rendered
  inside a conversation — opts in with `authoritative: true`.
- **Auto-completion recorded an empty artifact list.** `workspace/changes` is not appended
  with `turn/end`: the recorder enqueues a turn-end snapshot and diff when the turn closes
  and announces the result in a later event. Completing on `turn/end` therefore always saw
  no files. The record is now written when that summary arrives, with a bounded wait so a
  turn that changed nothing still completes, and a new turn settles the previous wait.
- **A stated blocker was overwritten by an automatic "done".** Auto-completion now backs off
  when the agent used a verdict tool of its own (`global_todo_done`, `global_todo_update`,
  `global_todo_remove`) during the turn: an agent that says "this is blocked, here is why"
  must not be contradicted by a heuristic. Read-only tools (`list`, `get`) do not count.
- **「交给 Agent」 did not mean "hand it to the conversation I am in".** The default was
  `auto`, which reused the session an earlier click had created — so a second click sent the
  work back to that side conversation instead of the chat on screen, and the first click
  opened a session nobody asked for. The panel now defaults to `current`, shows the target
  before the click, and the Host resolves "current" from the `api-session/activity` feed
  (the conversation the user last wrote in), falling back to the conversation the todo was
  written from. `auto` now means bound → current → new, and an unresolvable target fails
  with a reason instead of silently creating a conversation.
- **A hand-off created sessions with no working directory.** `meta.cwd` was only set when
  `dispatchDir` was configured, so the Host filed the new sessions under `_no-cwd` and the
  agent inside them could do nothing. The directory is now resolved in order — what the
  caller names, the directory the todo was written from, the bound conversation's
  directory, then `dispatchDir` — and a hand-off with none of them is refused with an
  actionable message instead of quietly creating a dead session.
- A live conversation with no working directory is flagged on its row, and `auto` no longer
  reuses one: it opens a fresh session in a resolved directory instead, so a single click
  recovers a todo that was handed to a dead-end conversation.

### Added

- Every todo written through a tool records `originDir` and `originSessionId`, read from
  the calling agent in `execute(args, exec)`.
- The panel's 工作目录 control: follows the conversation you are in (read from the shell's
  `useSessions` state), or a directory you pick with the Host's picker — remembered across
  sessions and overridable per dispatch.
- **A hot reload kept the previous stylesheet.** The panel's `<style>` tag was reused
  when it already existed, so new markup ran against the old rules: class names the old
  stylesheet never knew rendered with no styles at all — a panel that looked "unchanged"
  while its code was already new. The tag is now replaced (and stamped with the build
  revision), with a bundle test for the reload path.
- **The agent tools were missing entirely.** Their output schemas used
  `type: ['string', 'null']`, which the Host's schema subset does not accept, so
  registration was rejected for all seven tools. Nullability is now `oneOf`, and
  `test/schema.test.mjs` plus the Host-validator step in `npm run check` keep the
  class of failure out.
- The `/health` payload reports the tool registration state, which is what surfaced
  the failure in a live Host.

### Changed

- Rows now keep `▶ 交给 Agent` visible at all times (hiding the only way to hand work to an
  agent behind a hover made a lone todo look inert), list the first attachments as chips
  (a link opens, a document copies its path, `+N` for the rest), and separate the meta line
  with `·`.
- Row cards use the raised surface and a heavier title, so the list keeps its structure in
  a light theme; the row action is an outline button instead of a filled one.
- Panel redesign: urgency grouping with collapsible sections, hover-revealed row actions
  behind a menu, count chips that double as filters, a search field with a `/` hint,
  attachment rows with 打开 / 复制路径, an inline edit section with a dirty-state save,
  and a footer that names the keyboard shortcuts.
- The word "attachment" now covers addresses and documents consistently in the UI.

### Added

- Global todo list persisted as one JSON file (`$DSH_HOME/global-todo/todos.json`
  by default), written atomically and serialized so the human and the agent can
  never lose each other's change.
- Creation time on every entry: `createdAt` is set once, never edited, and shown
  in the panel, in the tool output and in every dispatch prompt.
- Attachments as references — any number of documents (absolute paths) and
  addresses (http/https) per todo, with URL credentials refused; documents stay
  where they are instead of being copied into plugin storage.
- Seven agent tools: `global_todo_add`, `global_todo_list`, `global_todo_get`,
  `global_todo_update`, `global_todo_link`, `global_todo_done`,
  `global_todo_remove`.
- Web panel in the sidebar with quick add, filters, text search, a detail view
  showing the activity trail, and inline attachment editing.
- One-click hand-off to an agent session: `auto` (reuse the bound conversation,
  otherwise start one), `new`, `bound` and `current` modes, with the outcome —
  success or the reason for failure — recorded on the todo.
- HTTP API (`/api/global-todo/*`) fenced by the host connection fence, with a
  strict loopback fallback and real status codes.
- Optional-service degradation: with no `webServer`, `tools`, `agents` or
  `agentPresets` service, the plugin loses exactly that surface instead of
  failing to load.

[Unreleased]: https://github.com/LUgABeEEE/dsh-global-todo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.2.0
[0.1.0]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.1.0
