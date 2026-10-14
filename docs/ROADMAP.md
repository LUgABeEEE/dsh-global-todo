# Roadmap

What could come next, ordered by value against effort. Everything here is a
proposal, not a commitment; the ones marked **next** are the strongest
candidates for 0.2.

## Landed in 0.1

- Global list, one JSON file, atomic writes, one write path for both writers.
- Creation time on every entry, immutable and shown everywhere.
- Attachments as references: any number of documents and addresses per todo.
- Seven `global_todo_*` tools; panel and tools share the same validation.
- Four hand-off modes, with success **and failure** recorded on the record.
- Restore/undo for a delete, keyboard shortcuts, editable detail panel.
- Proactive capture: `global_todo_capture` for batches, plus guidance that says when the
  agent should record something itself and when it must not.

## Next

### 1. Attachment health

A referenced document can be moved or deleted, and today the list cannot tell
you. Proposed: on read, mark each file link as `present` / `missing`, show a
warning chip on the row, and offer 「重新挂载」 next to it.

- Effort: small. The store already knows how to probe existence
  (`requireExistingFiles`); this reads the same probe per link.
- Cost to watch: one `stat` per file link per list read. Cache by mtime, or
  check lazily on the detail view only.
- Why it matters: the whole point of reference-style attachments is that the
  path stays valid **and visible when it stops being valid**.

### 2. Checklist inside a todo

Large items ("ship the plugin") are really a list of steps. Proposed: an
optional `steps[]` on a todo, rendered as checkboxes, and shipped to the agent
as a numbered plan in the dispatch prompt.

- Effort: medium (model + tools + panel + prompt builder).
- Why it matters: it removes the need for a separate "plan" plugin, and the
  dispatch prompt gets materially better.

### 3. Session read-back

The panel now shows whether the bound session is alive (`sessionAlive`).
Next: show what that session last said — one line of its latest assistant
message, and a link to open it — so a dispatched todo reports back where the
work is.

- Effort: medium. Needs a host-side read of the bound session (the `sessions`
  service exists, but this must stay cheap and failure-tolerant).
- Why it matters: hand-off stops being fire-and-forget.

### 4. Due reminders

A reminder when a due time passes, in the GUI and optionally to the IM channel
this deployment already has.

- Effort: medium. The plugin has no scheduler today; the Host's timer service
  plus a config flag is the smallest version.
- Careful: **remind only, never auto-dispatch.** The list belongs to the
  human; starting work stays an explicit act. (Auto-dispatch was rejected in
  `DESIGN.md` for this reason.)

### 5. Batch and multi-select

Shift-click to select, then 完成 / 交派 / 打标签 across the selection.

- Effort: medium (panel state + one bulk route).
- Why it matters: clearing a Monday backlog is 12 clicks today.

### 6. Import and export

Markdown / TaskPaper / plain JSON in and out, so the list can be migrated from
(and to) any other tool and diffed in a repo.

- Effort: small for JSON (the file *is* JSON), medium for the text formats.
- Why it matters: the store is already portable; the round trip just needs a
  parser and a button.

### 7. Smarter search

`#tag`, `is:overdue`, `has:attachment`, `before:2026-11-01` in the search box,
matching the syntax people already use elsewhere.

- Effort: small (a tokeniser in front of the existing filter).
- Why it matters: filters and text search currently live in two different
  controls.

### 8. Progress notes

A todo has exactly one free-text field, the description. So an agent reporting on work in
progress has to rewrite the user's own text, which is why the first blocker report appended
to the description instead of commenting. A small append-only note trail (with who and when)
would let an item accumulate history without its description becoming a scratchpad — and it
is the natural place for "I could not finish this, here is why".

### 9. What the agents produced

Completions already record a summary and the changed files per todo. A cross-todo view —
"what did the sessions finish this week, and what did they touch" — would turn that into
something you can review, and would be the honest way to show that a hand-off did work.

## Later

| Idea | Note |
|---|---|
| Image attachments | `kind: 'image'` next to `url`/`file`, backed by the official `attachments` service. The shape is already prepared for it. |
| Official `storageDomain` backend | A second store backend behind the same interface; the file stays the default because it is the feature. |
| Virtualised list | Only needed past a few hundred rows; measure first. |
| Drag to reorder | Manual order is meaningful to some people; it also needs a stable `position` field and a decision about how it interacts with due-date grouping. |
| Multi-list / projects | A `list` field with one default list; deferred because "global single list" is the current identity. |
| Archive instead of delete | Keeps history without cluttering; pairs well with #2. |
| Cross-machine conflict notice | The file is portable (NAS, sync folder). Detect "changed underneath me" and offer a reload instead of a silent overwrite. |
| Capture from outside the chat | Notifications, mail, announcements — the sources `dsh-todo-list` reads. Needs an ingest path and a policy for deduplication. |
| Metrics in `/health` | Dispatch success rate, tool call counts, list growth. |
| Accessible-only sweep | Full keyboard path is close; a screen-reader pass over the panel and the group headers is still owed. |

## Explicitly not planned

- **Auto-running todos.** A schedule that starts work without a person is a
  job queue, and this is a personal list.
- **Copying attachment bytes.** See `DESIGN.md`: references beat stale copies.
- **A second source of truth.** Anything that mirrors this list elsewhere
  (a database, a remote service) has to justify why the file is not enough.
