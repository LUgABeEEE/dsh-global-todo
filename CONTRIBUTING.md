# Contributing

Thanks for taking the time. This project is small on purpose: no build step, no runtime
dependencies, and a test suite that runs in a couple of seconds. Please keep it that way.
中文亦可，Issue 和 PR 用中文写没问题。

## Getting set up

```sh
git clone https://github.com/LUgABeEEE/dsh-global-todo.git
cd dsh-global-todo
npm run verify            # static checks + the whole test suite
dsh plugin --profile web add "$PWD"   # optional: try it in a live host
```

There is nothing to install: the plugin has no runtime and no development dependencies.
Node 22.19 or newer is all you need.

## The loop

1. **Open an issue first** for anything larger than a bug fix — a new field, a new route, a
   new dispatch mode. Design conversations are cheaper than review cycles.
2. Keep the change to one concern.
3. Add or extend tests. A behaviour change without a test will be asked for one.
4. Run `npm run verify`.
5. Open a PR and fill in the template.

## What the tests are for

| File | Protects |
|---|---|
| `test/links.test.mjs` | attachment rules, including the credential refusal |
| `test/model.test.mjs` | the entity: validation, patches, activity, tolerant loads |
| `test/store.test.mjs` | atomic writes, the write lock, corrupt-file behaviour |
| `test/service.test.mjs` | filters, sorting, the shared write path |
| `test/tools.test.mjs` | tool schemas and every tool's success and failure shape |
| `test/routes.test.mjs` | HTTP status codes, the fence, body limits |
| `test/dispatch.test.mjs` | all four dispatch modes, preset mounting, recorded failures |
| `test/bundle.test.mjs` | the browser half: registration, slots, theme tokens, route contract |
| `test/manifest.test.mjs` | `package.json`, the patch row, exports, version agreement |
| `test/schema.test.mjs` | the Host's tool-schema subset — a schema outside it is rejected at registration, silently |

## House rules

- **Plain ESM, no dependencies.** No bundler, no TypeScript, no `@deepseek-ai/*` import in
  `lib/`. Raw JSON Schema for tool parameters; raw `webServer.register` for routes. This is
  what keeps the plugin loading in lean compositions and across `0.2.x` releases.
- **Comments explain why, not what.** A non-obvious guard should say which failure it
  prevents. Restating a line of code in prose is noise.
- **User-facing strings need both languages.** Client dictionaries live in `lib/client.js`
  (`zh` and `en`); host-side messages are Chinese, matching the rest of the ecosystem.
- **Errors are typed.** Raise `TodoError` with a code from `lib/errors.js` rather than
  throwing a bare `Error`; the HTTP layer maps codes to statuses and the tests assert them.
- **Never write outside your own surface.** The client half contributes through slots and
  its own stylesheet tag; the host half registers routes, tools and one prompt section.
- **No secrets, ever.** The store is local and the plugin stores no credentials. The URL
  rule that refuses `user:password@` exists for this reason — do not relax it.

## Releasing

Facts checked on 2026-10-14, so nobody has to re-derive them:

- the npm name `dsh-global-todo` is **still free** (`registry.npmjs.org/dsh-global-todo` → 404);
- the GitHub account `LUgABeEEE` exists, but the repository
  `LUgABeEEE/dsh-global-todo` that `package.json` names **does not exist yet**
  (GitHub API → 404). Create it first, or fix the `repository` field before publishing:
  npm renders that link, and Trusted Publishing binds a package to a repository.

The order that avoids publishing a package pointing at nothing:

1. **`npm run verify`** — static checks plus the whole suite. This is also what CI runs.
2. **First commit.** The repository has none yet, so there is no history to preserve:
   `git init` and commit with the identity used across this machine —
   `git -c user.name=LUgABeEEE -c user.email=LUgABeEEE@users.noreply.github.com commit`.
   Before committing, confirm nothing secret is staged:
   `git diff --cached | rg -i "apiKey|password|token|PRIVATE KEY"`.
   `npm run verify` already performs the equivalent audit over every committable file, so a
   green run is the evidence — and it also asserts that `.gitignore` keeps the local
   artifacts (`node_modules/`, `preview/`, `todos.json`, backups) out of the commit.
3. **Push and watch CI for real.** The workflow matrix is Node 22.19 and 24; it has only
   ever been simulated locally, so the first green run is the first real evidence.
4. **Publish with Trusted Publishing (OIDC).** Bind the npm package to the GitHub repository
   and the workflow file in the package settings, then publish from CI with provenance —
   no long-lived token on a laptop. Locally, `npm pack --dry-run` is the dry run: it prints
   exactly what would ship.
5. **Cut the version.** Move CHANGELOG's `Unreleased` block under
   `## 0.1.0 — <date>`, keep `package.json`'s `version` and `VERSION` in `lib/index.js`
   equal (a test enforces it), and tag the commit.
6. **Ask for a listing.** The plugin index (`awesome-dsh-plugin`) takes a PR: one line plus
   a link, with `docs/screenshots/panel.png` as the picture.

## Reporting a bug

Include the plugin version (Settings → Plugins, or `GET /api/global-todo/health`), the DSH
version, what you did, what happened, and what you expected. A redacted snippet of
`todos.json` helps when the problem is about a record.
