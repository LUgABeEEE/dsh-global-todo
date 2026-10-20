## [0.7.1] — 2026-10-20

Documentation for the one piece of layout that cannot be "cleaned up".

- **`docs/DESIGN.md` now records why the wide-screen detail card is `position: fixed`**, with the
  measurements from the failed attempts (an absolute card came out 348×3051 at 1440; container
  queries make the panel the containing block for fixed descendants), the real cause (the panel
  scrolls with the host page, not `.gt-groups`), and the rules for changing it safely.
- `/api/global-todo/review` added to both README route tables (it shipped in 0.7.0 without its
  row).

## [0.7.0] — 2026-10-20

An agent's "done" becomes a claim a person confirms, instead of a fact.

- **Completing as an agent now leaves a review mark.** `todo.review = { pending, at, by }` is set
  by the model whenever the actor is `agent` (both `setStatus … done` and the completion path the
  tools use); a person finishing something sets none, and anything that leaves `done` clears it.
- **`POST /api/global-todo/review`** answers it: `confirm` keeps the todo finished and drops the
  mark, `reject` puts it back on the list with the completion record removed — "not actually done"
  is the only honest reading of a rejected claim. Answering twice is refused, not silently
  accepted.
- **The panel shows it**: a `待确认` chip on the row, a `待确认` filter that is the done list
  narrowed to pending marks, and `确认完成` / `退回清单` in the row menu. `counts.review` drives the
  chip and the filter.
- **Agents see it too**: `presentTodo` carries `review`, so an agent can tell that its completion
  is still waiting rather than assuming it landed.
- Two new model tests cover the rule (agent vs person, confirm vs reject, no double answers).

## [0.6.8] — 2026-10-20

Every conditional state now has a baseline image, and the harness refuses to render a blank
one.

- **Four new preview scenarios**: empty list, filter with no match, inbox, and a due reminder.
  `tools/preview.mjs` grew a `SCENARIOS` table the fake fetch reads, so a state that used to be
  reachable only by clicking can be rendered and photographed like any other.
- **`npm run screenshots` writes eight images** (list, detail, selection, settings + the four
  above). Both READMEs index them in a state table instead of embedding all eight.
- **`npm run check:render` asserts each state's marker** (`记第一条`, `清除筛选`, the inbox
  explanation, the reminder title), so a regression shows up as a failing check rather than a
  silently blank picture.

## [0.6.7] — 2026-10-20

Copy safety, and the last orphan of the old footer.

- **A test now guards the dictionaries.** `test/locale.test.mjs` reads them as source text
  (a duplicate key is legal JavaScript and invisible at runtime) and fails on: a key defined
  twice, a key present in one language and missing in the other, full-width punctuation inside
  English copy, and a literal `t('…')` key that does not exist. It immediately found a real
  duplicate — `select.clear` — the same class of bug that shipped "more fields" on the overflow
  menu.
- **The duplicate is fixed properly**: the selection bar clears with its own key (`清空`/`Clear`)
  while the pick toggle and the two ask-bars share `清除`/`取消`.
- **Keyboard shortcuts get a home.** The hints left the footer in 0.6.0 and only survived in the
  empty state; they now open from `⋯ → Keyboard shortcuts` as a small card with `kbd` chips, and
  Escape closes it before anything else.

## [0.6.6] — 2026-10-20

Both forms now look like forms.

- **Add form** gets real labels and a hint under each field instead of placeholder-only inputs
  (a placeholder vanishes the moment you type, so it can never carry a rule), and the expanded
  area is separated from the title row by a hairline.
- **Detail editor** gets the same treatment: labelled Title / Priority / Due / Description rows.
- **The 340px detail card no longer fights its own grid.** Meta rows stack to one column inside
  the card, attachments wrap to their own lines, and the raw path is dropped there because the
  card cannot show it next to two buttons — the title still carries it as a tooltip.

## [0.6.5] — 2026-10-20

The three loose ends the spec called out but the earlier passes left behind.

- **Five type sizes, for real.** 12.5/11.5/10.5 collapse into 12 and 11, so the panel now uses
  exactly 20 / 14 / 13 / 12 / 11 — one ladder instead of eight near-identical steps.
- **Group actions move behind one kebab.** `Collect` and `Exempt` stop competing with the group
  title; an exemption keeps a small always-visible mute mark (it is a state, not an action) and
  the menu states both intents in words (`Collect from this conversation`, `Mute this workspace`).
- **Escape closes the innermost layer.** Settings, then the add form, then the open row — and a
  click outside the settings card dismisses it, matching every other popover. The gear toggles.

## [0.6.4] — 2026-10-20

The settings panel, rebuilt as an inspector instead of a stack of labelled rows.

- **Header and footer, finally.** A title row with a close button, three labelled groups divided
  by hairlines, and a save row pinned at the bottom — the token field no longer pushes the save
  buttons into the middle of the form with a field stranded beneath them.
- **Every field says what it does.** Help text sits under each label (`settings.*Hint`) rather than
  being implied by the label; the label-and-control grid keeps number inputs aligned at a fixed
  76px right-aligned box.
- **Ingest fields dim when ingest is off**, and `New token` becomes a quiet text link on the token
  label row (`Rotate token`) instead of a third equal-weight button.
- **About section** shows the data file and version on labelled rows; the card sizes to its content
  and scrolls internally when the window is short.
- `npm run screenshots` now also photographs a settings variant, so the README image is
  reproducible instead of hand-made.

## [0.6.3] — 2026-10-20

States that were still speaking to nobody.

- **The selection bar has one primary action.** Count and 全选/清空 sit on the left, `Assign` is
  the only filled button, `Complete`/`Archive`/tag stay quiet, and the ambiguous `Done` becomes an
  icon-only exit (it read as a second `Complete`).
- **The inbox explains itself**, and an empty filter now offers `Clear filter` instead of dead air.
- **The reminder bar says which set it is.** Copy moves to `Dismiss all` and the bar carries a note
  that these reached their reminder time, unlike Overdue.
- **Selection bar is sticky and 36px tall**, so the batch actions stay reachable while scrolling.

## [0.6.2] — 2026-10-20

The narrow-width details the spec called for after the two-column work.

- **Grouping becomes a dropdown when the column is narrow.** The three segmented buttons collapse
  into one `select` (Conversation / Time / Level) below 960px, so the toolbar stops taking a row
  for grouping at the width where rows are already tight.
- **The inbox explains itself.** Opening the inbox view now leads with one line: items were written
  by external sources or the agent and only join the list after confirmation.
- **Toasts are anchored to the panel.** `position: absolute` on the panel root instead of `fixed`
  against the viewport, so a notice appears above the list rather than at the bottom of the window.

## [0.6.1] — 2026-10-20

The follow-up pass from the design spec: the breakpoint now follows the panel, not the window,
and the form stops competing with itself.

- **Panel-measured breakpoint.** A `ResizeObserver` on the column sets `data-wide`; the detail card
  becomes a right-hand card only when the column itself is at least 960px. At 1100 the detail now
  expands inline under its row instead of squeezing the list into a 416px strip.
- **Inline detail stops repeating itself.** The card title is hidden in inline mode (the row title
  is directly above it) and keeps only the close affordance.
- **Add form.** The header action turns into an icon-only close while the form is open, so there is
  one `+ Add` on screen; the form orders 更多字段 before 添加, matching the spec.
- **Rows are 72px tall** at minimum, matching the spec's rhythm, and the detail/card radius is 10px.
- Dark theme verified against the real host: layer-2 rows, overlay inspector and ghost-active
  selected states all resolve correctly.

## [0.6.0] — 2026-10-20

A design pass over the whole panel: one list, fewer competing controls, one type scale.

- **The layout is a column, not a wrapping row.** `.gt-root`/`.gt-inner` gained `min-width: 0` so the
  column shrinks with its slot instead of overflowing at 1280 and 1100; the header wraps its actions
  and the toolbar is two semantic rows (filter/search above, context above the list). The working
  directory, handoff target and browse controls move behind a single Context toggle, collapsed by
  default.
- **Five type sizes and one weight scale.** 20/28 panel title, 14/22 row title, 13/20 controls and
  body, 12/18 metadata and section labels, 11.5 mono for paths. Buttons, inputs and tabs share a
  28px control height; the settings card is a 340px floating inspector (fixed, mutually exclusive
  with the detail card) instead of an in-flow block that pushed the list down.
- **Rows read top-down.** The title opens the detail (the kebab remains as a redundant door); the
  dispatch button is a quiet action instead of an outlined primary; metadata loses the origin path
  and the stray separator (CSS-generated dots), and tags cap at four. Group-level priority hides
  while the group is expanded, where every row already shows it.
- **Copy and states.** Full-width colons no longer leak into the English UI, `1 items` is fixed,
  priority chips say Urgent/High/Normal/Low instead of P-codes, the empty state has a primary
  action, the error banner can be dismissed, and the reminder bar keeps its accent on a 2px edge
  (amber text failed contrast). The footer's store path and version move into Settings → About.

## [0.5.3] — 2026-10-20

Settings a person can reach, and reminders that behave like reminders.

- **A settings popover.** Reminders and the external ingest door were both API-only; the header
  now opens a small panel for the reminder switch, the lead time, the ingest switch, the token
  (generate a fresh one in place; leave blank to keep the current) and the inbox confidence
  threshold. The token still never comes back from the host.
- **Reminders gained a lead time and a switch.** remindersEnabled and reminderLeadMinutes live in
  settings; the host sweep reads them each tick, announces at dueAt minus lead, and clears the due
  list when reminders are off.
- **Browser notifications are opt-in.** When the panel is open and a new deadline becomes due, it
  fires a system notification if permission was granted; otherwise the due bar offers to ask for
  permission. The notification is a bonus — the bar is the source of truth.

# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] — 2026-10-19

Three things the leaders in this category do that we did not.

- **Deadlines now say something.** A 30-second host sweep finds active records whose `dueAt` has
  passed and that were not announced yet; the panel shows a due bar, clicking an item opens it,
  and acknowledging clears it. The announced set lives in memory, so a restart re-announces an
  unacknowledged deadline once — the offline catch-up a reminder should have. A postponed
  deadline is a new reminder; an announced one stays quiet.
- **Readable numbers: `#42`.** Records get a stable, human-facing sequence number assigned on
  create and backfilled in creation order for legacy files; deleting #1 does not renumber #2. It
  shows in the panel meta, in tool output and in the list line, so "把 #42 交给 Agent" means the
  same thing to both sides.
- **Import previews before writing.** The panel runs a dry run first and shows 新增/更新 counts
  with a confirm button; a wrong file can no longer overwrite by mis-click. The preview is also
  available as `dryRun` on the route.
## [0.5.1] — 2026-10-19

The last two loose ends from the D4 audit.

- **The idle window is editable where the switch is.** It was already in the settings file and
  the API; now the panel has a number field next to 自动获取, writing on blur so typing 1 on the
  way to 120 does not save 1.
- **The inbox can be worked in batches.** In the inbox view, the selection bar offers 确认
  (removes the inbox mark) and 丢弃 (archives and removes it) instead of complete/archive, which
  do not mean anything for records nobody has confirmed yet.
## [0.5.0] — 2026-10-19

The last two pieces of the automatic-capture plan: an external door, and somewhere for its
uncertain items to wait.

- **`POST /ingest` is the only external entrance.** It is closed until `ingestEnabled` is true
  and a token is set; the token is compared in constant time, never returned by `/health`, and
  the settings file is chmod 600 because it may hold it. Every item must name a source
  (`mail` / `notification` / `announcement`) and a confidence, so nothing anonymous lands in the
  list.
- **Low-confidence items wait in an inbox instead of joining the list.** Below
  `ingestConfirmBelow` (default 0.8) a record is tagged `inbox`; the panel shows an inbox filter
  chip, a 待确认 badge, and 确认 / 丢弃 in the row menu. Confirming only removes the mark;
  discarding archives it. A weekly sweep archives inbox records nobody confirmed in seven days,
  so the inbox cannot become a second list.
- Items still pass the same dedupe gate as `global_todo_capture`; provenance stays visible as a
  `source:<kind>` tag after confirmation.
## [0.4.7] — 2026-10-19

Verified against the running GUI this time, with measured numbers instead of arithmetic.

- **The card no longer overlaps the list by its own padding.** `width: 360px` was applied
  content-box, so the card was 394px wide while the list reserved 380px — a 14px overlap that
  only showed up in a live box measurement. It is `box-sizing: border-box` now (990–1350 against
  a list ending at 970 at 1440×900).
- **Its vertical brackets come from the list, not the panel.** The panel fills the window, so
  measuring its bottom put the card over the footer; the anchors now come from `.gt-groups`
  (top + 10) and its bottom (+ 8 gap above the footer).
## [0.4.6] — 2026-10-19

The card existed; where it landed depended on a viewport assumption that the real shell does not
honour.

- **The detail card is measured from the panel, not from `50vw`.** In the GUI the plugin slot does
  not fill the window, so the viewport-derived right edge put the card on top of the list; the card
  now measures `.gt-inner` on open, on window resize and on a slot resize (sidebar collapse), and
  positions itself from that rectangle. The CSS fallback (used by the static previews, which are
  server-rendered and run no effects) assumes the centred 980px column.
## [0.4.5] — 2026-10-19

Polishing where the side detail sits, now that it exists.

- **The card is bracketed between the toolbar and the footer**, so it no longer covers the dir
  controls or the store line; the toolbar keeps its full width and only the list gives way; the
  card scrolls as one column instead of pushing the footer around. Same CSS-only mechanism, no
  markup change.
## [0.4.4] — 2026-10-19

Opening a todo on a wide screen used to push the list down and leave half the window unused.

- **The open row's detail is now a card beside the list**, above a 1100px viewport: it sits at
  the panel's right edge, the list keeps its own column, and the card scrolls on its own. Narrow
  windows keep the familiar inline expansion. The change is CSS-only over the existing markup —
  `.gt-root[data-wide-detail]` plus one media query — so there is still exactly one detail
  implementation; a second wide-screen render path would drift from the inline one at the first
  field change.
## [0.4.3] — 2026-10-19

The list is meant to live in a synced folder; a change from another machine should not be
something you find out about a day later.

- **A file changed elsewhere is counted and reported.** The store keeps an `mtimeMs:size`
  fingerprint of the file as this process last read or wrote it; a read that disagrees with it
  increments `externalChanges` (once per change, not once per poll) and records
  `lastExternalAt`, both surfaced through `/health.store`. The panel turns a new count into a
  one-line notice. Reads still trust a file that parses — this process cannot merge two writers'
  intent — but the person can see that it happened.
## [0.4.2] — 2026-10-19

Noise is the failure mode that matters for a list other people are asked to trust.

- **Capture decides with a gate, not a title comparison.** The old check compared normalized
  titles exactly against active rows, which missed the ordinary case — same errand, different
  wording — and happily re-admitted something finished yesterday. `lib/capture.js` now refuses an
  item when its normalized title matches a live row, when a close paraphrase (Dice over character
  bigrams, 0.8) appears within 72 hours, or when the same errand was finished in the last 7 days.
  Archived and cancelled rows are set-aside history and do not block a new one; every refusal
  carries its reason in `skipped[]`.
## [0.4.1] — 2026-10-19

The half-finished half: the selection could only be assigned, and the only way to get a record out
of the list was to delete it. Both are now actions of their own.

- **A selection can be completed, archived and tagged.** `POST /bulk` applies one change across the
  picked rows, and the selection bar gained 完成 / 归档 / a tag field. Each record still goes through
  the same validation and activity trail as a single edit; an id that no longer exists is reported
  in `unmatched` rather than failing the whole batch, because a selection is a human gesture and one
  stale row must not discard the other nine.

- **Archive instead of delete.** `archived` joined the statuses, so a finished-or-abandoned record can
  leave the active view without losing its history. The panel offers 归档 / 取消归档 in the row menu,
  the filter chip appears only once something is archived, and `global_todo_update` now accepts
  `status` at all — before this, marking something in progress required the tool named
  `global_todo_done`, which is exactly the kind of name/capability mismatch that makes a model misuse
  a tool.

Still deliberately out of scope for this release: the wide two-column detail layout, and the
cross-machine conflict check — both deserve their own pass rather than riding along with a data-model
change.
## [0.4.0] — 2026-10-19

The first release after the plugin was listed in a community catalog. It is a reliability
release: the features that already existed now tell the truth — a sort that honours every level,
a page that says it was cut, a language setting that applies, and an automatic collector that can
explain itself and survives a failed question.

- **An unknown working directory is a reason not to ask.** The exemption is keyed on where a
  conversation works; a place nobody can name cannot be checked against it, and asking there would
  volunteer a question in a workspace somebody may well have excluded. The decision now reports
  `unknown-dir` and stays quiet, and the panel's switch tooltip says so. The cost is a conversation
  whose cwd the Host never reported, which the event tracker normally supplies on its first message.

- **The automatic collect switch shows the last decision.** `/health` now reports the full decision
  list, so the switch's tooltip can say *why* nothing has happened — not quiet long enough, waiting
  for you, cooling down, retrying, or an exempt workspace — together with how many candidates are
  waiting and how many are due.

- **The automatic collect switch can explain itself.** The decision layer knew why a conversation
  was skipped — switched off, exempt, not quiet yet, waiting for a person, cooling down — and the
  timer threw that reason away, so `/health` could report `enabled: true` while nothing ever
  happened and give no way to tell why. The whole decision list is reported now, with the last one,
  the number of waiting candidates, and in-memory counters for asked / succeeded / failed / dropped.
  The settings file also reports how it loaded (`file` / `missing` / `corrupt`): "off because
  somebody turned it off" and "off because the file was unreadable" used to look identical.

- **A failed question no longer silences a conversation.** The cooldown was booked before the ask
  and survived a failed request, so `awaiting-human` kept that conversation quiet until a person
  happened to speak again — one transient resume failure turned the feature off for that
  conversation, permanently and invisibly. A failure now releases the booking and schedules a
  bounded retry (1 / 5 / 25 minutes, three attempts) before dropping the candidate with the reason
  recorded. The ask is bounded too: an `agents.resume` that never settles now times out after ten
  seconds instead of leaving the global `asking` flag set and silencing every conversation.

- **A priority sort that put `urgent` last.** The rank table was written when there were three
  levels, and adding a fourth did not touch it: the comparator read `undefined` for `urgent` and
  produced `NaN`, so `sort=priority` (and the panel's level grouping) moved P0 to the bottom.
  Every level now has a rank, and the test names all four in order.

- **The list stopped at 200 without saying so.** `/list` cut the page at a fixed limit while
  `counts` was computed over the whole file, so a list of 350 showed "350 open" above 200 rows.
  The reply now carries `matched` (before the cut) and `truncated`, the panel prints "showing the
  first N of M", and `global_todo_list` tells the model the same thing instead of letting it
  reason about a page as if it were the whole set.

- **The panel described the quiet window with the cooldown number.** The hint said "quiet for
  {n} minutes" while `{n}` was `cooldownMinutes`; the gate it describes is `idleMinutes`, and the
  two only looked identical because both default to 30. A hint that lies once the value is
  changed is worse than no hint.

- **Switching the interface language did nothing.** `resolveLang` read `locale` / `id` / `language`
  / `current` from the locale snapshot, but the snapshot carries `active`; the value was never
  found and the panel always fell back to `navigator.language`. It reads `active` first now, and
  the unused `workspaces` client dependency is gone.

- **The English panel was partly Chinese.** Seventeen keys — the whole `note.*` and `completion.*`
  groups, plus `link.missing`, `search.hint` and `detail.notes` — existed only in the Chinese
  dictionary and silently fell back; `meta.completed` was Chinese in the English table as well.
  Both tables now carry the same 186 keys, guarded by a test that also refuses a Chinese value in
  the English one.

- **Two empty states, one wrong.** The panel decided between "no todos yet" and "nothing in this
  filter" by looking at the current filter, so "all" with a search term and an empty list showed
  the wrong sentence. The decision now uses the list's real size and whether a search is active.

- **Opening a row near the bottom did nothing visible.** The detail expanded below the viewport;
  the row now scrolls into view when it opens.

- **The no-literal-colours test was checking fourteen characters.** It sliced from `const CSS =`
  to the first `.gt-root` inside the stylesheet, so it never inspected a colour. The slice now
  runs to the end of the template, which makes the guard real — and the theme-token rule is the
  one thing that keeps dark mode working.

- **Documentation that had drifted from the tree.** Both READMEs gained the five routes they were
  missing (`note`, `dirs`, `settings`, `assign`, `diagnostics`); `docs/DESIGN.md` records the four
  fields and two activity kinds added since the table was written; `cordis.patch.yml` names
  `guidance` and `browseRoot`, which a wholesale `config` override would otherwise drop;
  `docs/ROADMAP.md` cites files and functions instead of line numbers that had moved by dozens of
  lines.

- **The contribution terms are written down.** MIT in, MIT out — no CLA, no copyright assignment —
  so a future patch cannot quietly stay its author's property and block a license change years
  later. The READMEs also say plainly that this is a community plugin, not a DeepSeek project.

## [0.3.2] — 2026-10-19

No code change. `0.3.1` was published to npm by hand, so it carries no provenance attestation;
this release republishes the same source tree through the repository's `publish.yml` workflow,
which authenticates with OIDC (Trusted Publishing) instead of a token. From here on a release is
a tag: npm signs the attestation that ties the tarball to this commit and this workflow.

## [0.3.1] — 2026-10-17

A compatibility release rather than a feature one: DeepSeek Harness moved to `0.2.1-rc.2`, and
the plugin needed no code change to follow it — but three of its own notes described the old
Host, and a note that is out of date is what the next change gets planned around.

### Changed

- **Verified against DSH `0.2.1-rc.2`, and the picker notes now say what is true.** Nothing in
  the plugin had to change: the tool schemas still pass the Host's own validator, every service
  it injects is still there, and the client half touches only `slots` / `locale` / `effect` /
  `uiWorkspace`, whose contract did not move. What moved is the Host — 0.2.1 mounts its own
  directory picker, so the panel's `选择` is now the shell's native dialog and the built-in
  browser is a fallback rather than the normal case. Three comments and one notice said
  otherwise and have been corrected: a note that still claims a capability is missing is worse
  than no note, because the next reader plans around it.

## [0.3.0] — 2026-10-17

The round after 0.2.0: `/health` grew counters and a JSON export/import round trip, an agent
gained an honest way to reopen a todo it had finished by mistake, and automatic collect learned
both when to shut up — one question per message a person wrote — and where never to speak at all,
a workspace somebody exempted. The quiet auto-close from the middle of that round was removed
again the same night it shipped; the reason is written down in `DESIGN.md`.

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
- The tool count in the docs now matches the tree: **ten** `global_todo_*` tools
  (`add`, `capture`, `list`, `get`, `update`, `link`, `note`, `done`, `reopen`, `remove`), the
  same list `/health.tools.registered` reports. `ROADMAP.md` was re-audited against the code and
  now separates what has landed (with `file:line` citations) from what has not.
- **`global_todo_reopen` gives a wrongly-finished todo an honest way back.** It does exactly
  one thing — `done` / `cancelled` → `open` — records the act as the agent's (with an optional
  `reason` in the activity trail) and **refuses** an item that was never finished, instead of
  reporting a repair that did not happen. Until now the only agent-side path was `status` on
  `global_todo_done`, i.e. a capability filed under the tool whose name says the opposite, so a
  data repair reached for the HTTP route instead — and was filed as the person's work.
- **A workspace can be exempted from automatic collect.** The `Exempt` action on a conversation's
  group header takes that conversation's whole **working directory** out of scope, and
  `/health.settings` reports the list so the panel can show which places are out. It is keyed on
  the directory rather than on a session id because the conversations that need it are the ones a
  machine drives — a chat companion's room — and such a session is recreated with a new id when it
  restarts, so an id-keyed exemption would quietly stop applying. Subdirectories count; a shared
  prefix does not, and a conversation whose directory nobody reported is not treated as exempt.
  The directory is remembered from the conversation's own events rather than looked up when the
  timer runs, because these conversations are idle most of the time and an idle conversation is
  one the Host may have unloaded — where a live lookup answers `''`, and the exemption would stop
  applying to exactly the conversations it exists for.

### Fixed

- **The panel's `/update` and `/status` routes no longer need a lie to accept a write.** Both
  hardcoded `by: 'human'`, so a script repairing data on an agent's behalf filed the change as
  the person's own — the four reopens from the mis-close repair are recorded that way, and the
  only thing saying otherwise was a sentence in a note. Both routes now take an explicit
  `by: 'agent'` and still default to `human`; any other value is a `400`, because quietly
  folding a typo into `human` is the same lie with better manners.

- **Automatic collect no longer asks the same conversation over and over.** The question the plugin
  sends *is* a message in the conversation, so it restarted the plugin's own quiet clock, and the
  answer to it ended a clean turn — which put the same conversation straight back in the queue. With
  `cooldownMinutes` on the same half hour as `idleMinutes`, the cooldown had always expired by the
  time the quiet window opened, so one conversation was asked every half hour, all night, with
  nobody there. A conversation is now asked **once per message a person wrote in it**: only
  `source.kind === 'user'` re-arms it, and the plugin's own traffic never does. A restarted Host has
  forgotten the timestamps and so stays quiet, which is the direction to fail in.

- **A quiet conversation no longer has its open todos closed for it.** Yesterday's helper read
  "this conversation has gone quiet" as "its work is finished" and closed every open todo that
  conversation had written, under a template summary. On its first night it closed eight that were
  not finished — one waiting on a person, one waiting on an event that had not happened yet — and
  the only thing that told them apart was that summary, because there was no evidence behind it.
  The signal is not weak, it points the wrong way: a conversation falls quiet *because* it is
  waiting, so the items that matter most are the ones it gets wrong. Only paths that carry evidence
  close a todo now — the agent's own `global_todo_done`, the hand-off watcher, or a person in the
  panel — and the module that held the heuristic is gone.

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

- **A quiet conversation has its finished work ticked off for it.** Asking an agent to close what
  it finished works most of the time, which is not the same as a tidy list — so when a conversation
  that *wrote* todos has been quiet for the idle window after a clean turn, the Host closes the ones
  it owns, with a summary saying why ("插件按「做完就划掉」结束了它写下的这条"), and it is reversible.
  It touches only that conversation's own todos, and it is deliberately independent of the
  automatic-collect switch: tidying is not the same feature as asking for more.
- **`/health` reports `idleMinutes`** (and the settings write echoes it). The rule in force has to
  be observable — a check that could not see it reported "not deployed" for code that was running.


- **Automatic collect now waits for quiet, instead of asking at every turn end.** That was the
  design mistake behind "too frequent": a session being worked in ends turns every few minutes, so
  the question arrived mid-work, repeatedly. A clean turn now only *marks* the conversation as a
  candidate and records **when it went quiet**; a one-minute timer asks when nothing has been said
  for `idleMinutes` (default **30**) — and any new message, or the start of a new turn, restarts
  that clock. Asking is also still gated on the conversation being the one the person is in, the
  turn having ended cleanly, and the per-session cooldown. Not knowing how long it has been quiet
  counts as "not yet" (fail closed).
- **Captured items are refined and merged rather than transcribed.** The capture prompt now asks
  for one entry per matter, merges scattered points into a single entry's description, targets
  "1–3 entries, not 8", and refuses to record what the list already has. The capture tool enforces
  the last part: an item whose normalised title matches an unfinished entry is skipped with
  「清单里已有同名的未完成条目」 instead of being registered again — which is how the list kept
  filling with near-duplicates.


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

[Unreleased]: https://github.com/LUgABeEEE/dsh-global-todo/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.3.1
[0.3.0]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.3.0
[0.2.0]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.2.0
[0.1.0]: https://github.com/LUgABeEEE/dsh-global-todo/releases/tag/v0.1.0
