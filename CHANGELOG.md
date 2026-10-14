# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-14

The first release: one JSON list a person and an agent both write to, eight agent tools, a
panel that hands work over and records how it finished.

### Added

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

## [0.1.0] - 2026-10-13

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

[Unreleased]: https://github.com/LUgABeEEE/dsh-global-todo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.1.0
