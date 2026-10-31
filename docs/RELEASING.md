# Releasing

The runbook for cutting a version. It exists because the same three mistakes have already cost
this repository a release each: a transplant that linearized public `main` over an unpublished
commit, a GitHub release whose asset was a 21-byte JSON error, and a publish that ran after the
catalog rebuild and stayed invisible for a day. Every step below is copy-pasteable, and the
checks are the ones that would have caught them.

`AGENTS.md` states the rules; this file is the procedure.

## 0. Is it time?

```sh
npm run release:check     # 0 = go, 10 = hold (cadence), 20 = nothing to release
```

At most **one release a day**, and publish **before 04:2x UTC** (Beijing 12:2x) — that is when the
market's catalog rebuilds, so a version published after it waits a full day. The escape hatch is
`workflow_dispatch` with `force: true`: a data-loss or security fix, or retrying a publish that
failed.

## 1. The tree that will be published

```sh
git status --short          # must be empty
node -e 'console.log(require("./package.json").version)'   # X.Y.Z
grep -n "VERSION = " lib/index.js                          # the same X.Y.Z
npm run verify              # static checks, render check, the full suite
node tools/contracts-check.mjs
npm run check:live          # against the running Host, if there is one
```

`prepack` runs `verify` again on publish, so a broken tree fails in CI rather than on npm.

## 2. Commit, tag, push (private)

```sh
git -c user.name=LUgABeEEE -c user.email=LUgABeEEE@users.noreply.github.com commit -m "chore(release): X.Y.Z — <one line>"
git -c user.name=LUgABeEEE -c user.email=LUgABeEEE@users.noreply.github.com tag -a vX.Y.Z -F /tmp/tag-message.txt
git push origin main
git push origin vX.Y.Z
```

`git tag -a` needs the identity flags too: an annotated tag is a commit, and this machine has no
global `user.name`.

## 3. Transplant to the public repository — **preflight first**

The public repository is the trusted publisher; the private one is where work happens. A transplant
pushes one tree as a single new commit, so the two histories are unrelated and can drift silently.

```sh
PUBLIC=https://github.com/LUgABeEEE/dsh-global-todo
git fetch "$PUBLIC" main:refs/remotes/public/main
# 1. What does public main hold now?
git log --oneline -3 refs/remotes/public/main
# 2. Does its tree equal the tree of the private commit the LAST transplant published?
git rev-parse refs/remotes/public/main^{tree}
git rev-parse <last-transplanted-private-commit>^{tree}
```

**When the two differ, stop.** One of the two repositories already moved — a half-finished release,
or another session — and pushing now linearizes public `main` over commits nobody transplanted.
Name the missing commits and decide about each one; never publish a union.

Then push the tree, with the empty-sha guard (an empty source ref *deletes* the branch):

```sh
NEW=$(git -c user.name=LUgABeEEE -c user.email=LUgABeEEE@users.noreply.github.com commit-tree HEAD^{tree} -p "$(git rev-parse refs/remotes/public/main)" -F /tmp/public-commit.txt)
test -n "$NEW" || { echo "empty sha, refusing"; exit 1; }
git push "$PUBLIC" "$NEW:refs/heads/main"
git push "$PUBLIC" "$NEW:refs/tags/vX.Y.Z"
```

The tag push triggers `publish.yml` (OIDC, no token). `gh run list --repo LUgABeEEE/dsh-global-todo`
shows it; a red run means nothing was published.

## 4. Wait for the registry, then build the release asset from it

Metadata can appear minutes before the tarball, and the tarball is what the release must carry:

```sh
curl -s https://registry.npmjs.org/dsh-global-todo/X.Y.Z | grep -o '"version":"[^"]*"'
curl -sI https://registry.npmjs.org/dsh-global-todo/-/dsh-global-todo-X.Y.Z.tgz | head -1   # 200
curl -sL -o /tmp/dsh-global-todo-X.Y.Z.tgz https://registry.npmjs.org/dsh-global-todo/-/dsh-global-todo-X.Y.Z.tgz
ls -l /tmp/dsh-global-todo-X.Y.Z.tgz        # a few MB, never a few hundred bytes
gh release create vX.Y.Z /tmp/dsh-global-todo-X.Y.Z.tgz --title "X.Y.Z — <one line>" --notes-file /tmp/notes.md
gh release view vX.Y.Z --json assets --jq '.assets[] | .name + " " + (.size|tostring)'
```

A 21-byte asset is npm's `{"error":"Not found"}` saved as a file: it happened on 0.20.0, and the fix
is `gh release delete-asset` + `gh release upload` once the tarball exists.

## 5. The market index — after the version is on npm

Built from the registry, so it is always one commit behind the tag:

```sh
npm run market          # regenerate docs/market/index.json
npm run market:fresh    # compare with the registry; must say "current"
git add docs/market/index.json
git -c user.name=LUgABeEEE -c user.email=LUgABeEEE@users.noreply.github.com commit -m "chore(market): index X.Y.Z"
git push origin main
# then the same guarded transplant as step 3, against the new public main
```

## 6. Afterwards

- `gh run list` — CI and Pages green on public `main`.
- The landing page: `https://lugabeeee.github.io/dsh-global-todo/` — the new version in the install
  block, and whatever section this release is about actually present.
- The plugin runs the *old* version until `dsh-web` restarts. **Restarting is not part of
  publishing**; report it and let the user pick the moment, after the restart guard
  (`dsh-restart-guard.sh`, described in `AGENTS.md`) exits 0.

## What each guard is for

| Step | The failure it prevents |
|---|---|
| `release:check` | a version published after the catalog rebuild, invisible for a day |
| tree compare | public `main` linearized over an unpublished commit (2026-10-25) |
| `test -n "$NEW"` | `git push "":refs/heads/main` deleting the default branch (2026-10-23) |
| tarball size | the release asset being npm's error JSON (0.20.0) |
| `market:fresh` | an index that offers a version the registry does not have |
