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
tarball. Stop there.

**Never restart `dsh` from a turn.** The host runs in-process sessions for every open
conversation, so a SIGTERM drops whatever they were midway through — on 2026-10-20 a
`sleep 20 && kill` shipped from this repository cut five unrelated sessions, one of them a
release conversation. Report the new version and let the user pick the moment. If a restart is
genuinely needed, run `$DSH_HOME/tools/dsh-restart-guard/dsh-restart-guard.sh` first: exit 0
means nothing is in flight, 10 means other conversations are open (ask), 20 means a subagent is
running (do not restart — its work is lost).

## Style

- Comments explain **why** a guard exists, not what the next line does.
- Chinese for host-side user-facing strings and repository docs; both `zh` and `en` in the
  client dictionaries.
- Keep functions small enough to read in one screen; prefer plain data over classes.
