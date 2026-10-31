# Repository notes for coding agents

Scope: this repository is the plugin `dsh-global-todo` — one DeepSeek Harness bundle with a
host half (`lib/`, plain ESM) and a browser half (`lib/client.js`, classic script).

## Hard constraints

- **No dependencies.** Do not add runtime dependencies, and do not `import` any
  `@deepseek-ai/*` package in `lib/`. Services are reached through `ctx.inject([...], cb)`
  or a guarded `ctx.get(name)`. Tool parameters are raw JSON Schema; routes are registered
  with the raw `ctx.webServer.register` contract.
- **No build step.** `lib/client.js` is authored by hand and registers itself with
  `window.__ModuleLoader__`. Never introduce a bundler, TypeScript or a generated file.
- **Two writers, one path.** Every mutation goes through `lib/service.js` and lands in
  `store.update`, which takes the cross-process lock (`lib/lockfile.js`) and does the
  read-modify-write under it. If you add a rule, it must apply to the panel and the tools at once.
- **One registration per route path.** The Host keys exact routes by **path alone**
  (`dsh-host-webserver`), and this bundle registers its whole list in one pass: a second
  definition for the same path throws `duplicate exact route`, and every route declared after
  it silently disappears — reads keep answering while every write returns a bare 404 (that is
  how `/sync`, registered once for GET and once for POST, cost eighteen routes on 2026-10-29).
  A path that answers more than one verb is **one** definition that checks the verb itself
  (`verbs` in `lib/routes.js`); `test/routes.test.mjs` and the smoke-test host both reject a
  duplicate instead of letting it pass.
- **Never write the store file directly.** `store.write` is internal to `update`; a writer that
  bypasses the lock is exactly the overwrite 0.18.0 fixed. A new failure gets a code in
  `ERROR_CODES` and a status in `statusForCode` — `store-busy` is 503, not 500, because the same
  request usually succeeds a moment later.
- **A removal leaves a tombstone.** `service.remove` pushes `{ id, at, by }` into `doc.trash`, and
  `store.update` writes that array back with the todos. A mutator that drops a record without the
  mark makes the deletion local-only: the next fold from another machine puts the record back
  (0.21.0). `restore` must take the mark away for the same reason.
- **The fold is pure, the share is not.** `lib/replica.js` merges two documents and touches no
  filesystem, network or clock beyond the `now` it is handed; `lib/sync.js` owns the mount, the hub
  lock and the timeouts. Put a merging rule in `replica.js` so the import path and the sync path
  cannot disagree, and keep it commutative/idempotent: the test asserts both.
- **Typed failures.** Throw `TodoError` from `lib/errors.js` with a code listed in
  `ERROR_CODES`. `lib/routes.js` maps codes to HTTP statuses; `lib/tools.js` turns them into
  `{ ok: false, reason, error }` values instead of throwing at the model.
- **Tool schemas live in a small subset.** The Host accepts only
  `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` /
  `const` plus annotations; `type` must be a **single type string**, so nullability is
  `oneOf: [{ type: 'string' }, { type: 'null' }]` and never `type: ['string', 'null']`.
  A schema outside the subset is rejected **at registration**, quietly: the panel still
  works and the model simply has no tools. `npm test` (test/schema.test.mjs) and
  `npm run check` (against the real validator when a profile exists) both guard this.
- **Never persist a secret.** The URL attachment rule refuses `user:password@`. Do not relax
  it, and do not log attachment values at info level.
- **Theme tokens only.** The panel uses `--dsw-alias-*` / `--dsw-specific-*` variables. Hex
  and `rgb()` literals fail `npm test`.

## Workflow

```sh
npm run verify   # static checks then the full test suite; run before every commit
```

Touching the phone layout? `npm run preview:mobile && npm run check:mobile` measures every target
in a real browser (44×24 minimum) instead of trusting the stylesheet; `verify` cannot, because it
needs the borrowed Playwright and the rendered previews.

- `package.json` `version` and `VERSION` in `lib/index.js` must match (a test enforces it).
- The bundle row id (`global-todo`), the package name, the client `id` and the sidebar slot
  id all have to agree; `test/manifest.test.mjs` and `test/bundle.test.mjs` check this.
- The client calls routes with a **document-relative** path (`api/global-todo/...`); the host
  registers them with a leading slash. `test/bundle.test.mjs` cross-checks the two lists.
- Adding a route: register it in `lib/routes.js`, call it from `lib/client.js`, and extend
  the route table in `README.md` (both language halves) and `docs/DESIGN.md` if it changes shape.
- Adding a field to a todo: `lib/model.js` (create + `applyPatch` + `normalizeStored`),
  `lib/tools.js` (`presentTodo` and the relevant JSON Schemas), `lib/client.js` (render),
  plus `docs/DESIGN.md`.
- The memory bridge (`memoryGuidanceFor`, and the `hasMemory` line in a completion result) must
  stay **gated**: no memory plugin, no sentence. A prompt section that names `mnemon_remember` on a
  machine without it is the same bug as naming `global_todo_capture` in `core` mode, and
  `tools/contracts-check.mjs` group I pins both.
- Adding a tool: define it in `lib/tools.js`, then update **every** place the count is written
  down — the header comment there, the tool table in `README.md` (both halves), `docs/DESIGN.md`
  (the service table), `docs/ROADMAP.md` and the assertion in `test/smoke.test.mjs`. This has
  drifted before — `docs/DESIGN.md` still said "the seven agent tools" — because only one of
  those files was updated at a time.

**Two READMEs, one language each, and a switch on the first line of both.** `README.md` is the
Chinese document — the name GitHub renders on the repository page, and the only one npm renders at
all — and `README.en.md` is the English one. Each opens with `**中文** · [English](…)` /
`**English** · [中文](…)` pointing at the **absolute** GitHub URL of the other file: npm rewrites or
drops relative links, and a CJK heading slug is not stable across renderers, so an absolute file URL
is the only form that survives all three surfaces (GitHub, npm, the plugin page). `README.zh.md` is a
two-line landing page that keeps old links resolving — not a second copy of the text, and not a file
to update when the content changes. Edit both documents in the same commit: a fact that is only in
one of them is a fact half the readers get.

### Issue labels

Five labels carry the whole vocabulary: `bug`, `enhancement`, `documentation`, plus two this
repository adds — `windows` (only breaks, or only differs, on Windows: paths, the atomic write's
read-only handle, encoding, screen readers) and `distribution` (npm, plugin catalogs, the 1024 Store:
anything about being found rather than about the plugin itself). GitHub's defaults — `duplicate`,
`invalid`, `question`, `wontfix`, `good first issue`, `help wanted` — stay unused in practice; do
not invent a label per subsystem. Label the closed issues too: the closed list is the only record of
what the Windows sweeps have already cost, and an unlabelled one is invisible the next time the same
symptom appears.

## Releasing

Publishing is automated: bump both versions, `npm run verify`, commit, tag `vX.Y.Z`, push, and
let the `publish` workflow publish over OIDC. Then create the GitHub release from the registry
tarball. **The release ends there.** A restart is never part of publishing.

**The procedure is `docs/RELEASING.md`** — every command, in order, and the guard each step
prevents. Follow it rather than reconstructing the steps from memory.

`docs/market/index.json` is the plugin market index the landing page tells readers to add in DSH's
Discover tab. It is built from the **registry**, so the order is fixed and it is one commit behind
the tag:

1. bump both versions, `npm run verify`, commit, tag, push → the publish workflow releases it;
2. **after** the version is on npm: `npm run market` (regenerate), `npm run market:fresh`
   (compare against the registry), commit `chore(market): index X.Y.Z`, push.

The offline suite only asserts that the index never offers a version newer than this tree, because
equality cannot hold between a bump and its publish — and `prepack` runs that suite, so a strict
equality test makes every release after a bump unpublishable. Freshness is `market:fresh`'s job,
and it needs the network.

### Release cadence (hard)

**At most one release a day**, unless the change is a data-loss or security fix — shipping one of
those an hour late is worse than shipping twice in a day.

The reason is distribution, not tidiness. Every catalog a reader browses rebuilds **once a day**
(the market's catalog publishes around 04:2x UTC, and `awesome-dsh-plugin.com/plugins.json`
follows), so a version published at 13:00 is invisible until the next rebuild. Worse, the market
**pins the version it lists** when it installs: a stale catalog installs a stale build. Seven
releases went out between 12:22 and 20:04 on 2026-10-22, and two days later readers were still
being offered 0.12.13.

`npm run release:check` reports the picture and exits on the same convention as
`dsh-restart-guard`, so a caller can branch on the code instead of parsing prose:

| exit | meaning | what to do |
|---|---|---|
| 0 | nothing pending, or the window is open | release when you like |
| 10 | released recently and ordinary work is waiting | hold it for the daily window |
| 20 | nothing releasable since the last tag | there is no release to cut |

Publish **before 04:2x UTC (Beijing 12:2x)** — that is when the catalog rebuild runs, so a version
published after it waits a full day. The publish workflow enforces the interval itself
(`release-check --registry`, reading npm's own publish times because a tag checkout is one commit
deep). Its escape hatch is `workflow_dispatch` with `force: true`, for the two cases that are not
ordinary releases: a data-loss/security fix, and retrying a publish that failed.

`npm run usage:check` answers the other half of the question: whether a download number means
anyone. A burst spread evenly across every version published that day, with the repository's stars
and views flat, is a crawler walking new versions — on 2026-10-22 that shape produced 1,526
downloads for a plugin with one real user. Do not read a download spike as an audience without it.

### Transplanting to the public repository (hard)

The public repository is the trusted publisher; the private one is where work happens. A transplant
pushes one tree as a single new commit on public `main`, so **the public history is not the private
history** and the two can drift without anything failing. Two rules follow:

**Preflight: compare trees, never assume.** Before pushing, compare public `main`'s tree with the
tree of the private commit the *last* transplant published. If they differ, one of the two
repositories already moved — a half-finished release, or another session — and pushing now
linearizes public `main` over commits nobody transplanted. That happened on 2026-10-25: a
`chore(release): 0.19.0` was committed and tagged in the private repository but never transplanted,
and the next legitimate transplant jumped public `main` straight to a tree that contained the
unreleased version. Read `git ls-remote --tags <public>` and the public log first; when the two
disagree, name the missing commits and decide what to do with each, instead of publishing a union.

**Never push a computed ref unguarded.** `git push "$NEW:refs/heads/main"` with an empty `$NEW`
is not a no-op: an empty source means *delete that ref*. It happened on 2026-10-23 when
`git commit-tree` had failed on an unset identity — GitHub refused to delete the default branch,
which is luck, not a guard. Every script computes the sha into a variable and then
`test -n "$NEW" && git push …`, the way the transplant pushes below already did.

### The restart rule (hard)

`dsh-web` is a single process: a SIGTERM drops every in-flight turn, every subagent, every MCP
child. Two independent sources of "random" interruptions have been confirmed on this machine —
an unconditional `sleep N; kill` shipped from this repository (2026-10-20, six times, one of
them a release conversation) and `needrestart` restarting the unit after unattended-upgrades
(2026-10-21 06:29). What follows is the standing convention:

1. **Never run `sleep N; kill -TERM $(MainPID)`.** That is the pattern that caused the damage;
   it does not ask anything before it fires.
2. **Report, then let the user pick the moment.** "0.12.0 is on npm; restart when you like" is a
   complete hand-off. This is the default and needs no further tooling.
3. If a restart is genuinely required, **run the guard first and print its output** into the turn:

   ```sh
   "$DSH_HOME/tools/dsh-restart-guard/dsh-restart-guard.sh"
   ```

   | exit | meaning | what to do |
   |---|---|---|
   | 0 | nothing in flight | a restart is safe — still ask, unless the user already said yes |
   | 10 | other conversations are open | ask; never restart on your own |
   | 20 | a subagent is running | **do not restart** — its drafts are lost |
   | 12 | cannot decide | treat as 10 |

4. A restart always needs the user's word in the current turn. "只有我自己在飞" is a fact, not a
   permission.
5. After any restart, the evidence to check is `turn/end {"kind":"interrupted"}` in
   `~/.dsh/sessions/*/session.v4.jsonl.zstd` (zstd -dc, then grep): a restart that cut someone
   leaves that signature at the timestamp of the restart.

Making the host itself resist `needrestart` is a root action, not one an agent can take:
`/etc/needrestart/conf.d/99-dsh-keep.conf` with
`$nrconf{override_rc}{qr(^dsh-web\.service$)} = 0;` — the user runs it, the agent verifies that
`dsh-web` stops appearing in "Restarting services...".

## Style

- Comments explain **why** a guard exists, not what the next line does.
- Chinese for host-side user-facing strings and repository docs; both `zh` and `en` in the
  client dictionaries.
- Keep functions small enough to read in one screen; prefer plain data over classes.
