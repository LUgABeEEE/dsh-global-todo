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
- **Two writers, one path.** Every mutation goes through `lib/service.js`. If you add a rule,
  it must apply to the panel and the tools at once.
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

- `package.json` `version` and `VERSION` in `lib/index.js` must match (a test enforces it).
- The bundle row id (`global-todo`), the package name, the client `id` and the sidebar slot
  id all have to agree; `test/manifest.test.mjs` and `test/bundle.test.mjs` check this.
- The client calls routes with a **document-relative** path (`api/global-todo/...`); the host
  registers them with a leading slash. `test/bundle.test.mjs` cross-checks the two lists.
- Adding a route: register it in `lib/routes.js`, call it from `lib/client.js`, and extend
  the route table in `README.md`, `README.zh.md` and `docs/DESIGN.md` if it changes shape.
- Adding a field to a todo: `lib/model.js` (create + `applyPatch` + `normalizeStored`),
  `lib/tools.js` (`presentTodo` and the relevant JSON Schemas), `lib/client.js` (render),
  plus `docs/DESIGN.md`.
- Adding a tool: define it in `lib/tools.js`, then update **every** place the count is written
  down — the header comment there, the tool table in both READMEs, `docs/DESIGN.md` (the
  service table), `docs/ROADMAP.md` and the assertion in `test/smoke.test.mjs`. This has drifted
  before — `docs/DESIGN.md` still said "the seven agent tools" — because only one of those files
  was updated at a time.

## Releasing

Publishing is automated: bump both versions, `npm run verify`, commit, tag `vX.Y.Z`, push, and
let the `publish` workflow publish over OIDC. Then create the GitHub release from the registry
tarball. **The release ends there.** A restart is never part of publishing.

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
   /data/agent/tools/dsh-restart-guard/dsh-restart-guard.sh
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
